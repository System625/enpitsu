import asyncio
import base64
import json
import logging
import os
import re
import uuid
from typing import Dict, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from agent import GeminiAgent
from image_gen import ImageGenerator
from processor import StoryProcessor

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Enpitsu Backend")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten to Firebase Hosting domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Firebase Admin SDK — initialised once at startup if credentials are available
# ---------------------------------------------------------------------------
_firebase_initialized = False
_db = None  # Firestore client (None if Firebase not configured)


def _init_firebase():
    global _firebase_initialized, _db
    if _firebase_initialized:
        return
    try:
        import firebase_admin
        from firebase_admin import credentials
        from firebase_admin import firestore as fs

        if not firebase_admin._apps:
            cred = credentials.ApplicationDefault()
            firebase_admin.initialize_app(cred)
        _db = fs.client()
        _firebase_initialized = True
        logger.info("Firebase Admin SDK initialized (Firestore enabled)")
    except Exception as e:
        logger.warning(f"Firebase Admin SDK not available — persistence disabled: {e}")
        _firebase_initialized = True  # don't retry


_init_firebase()


# ---------------------------------------------------------------------------
# Firebase Auth token verification helper
# ---------------------------------------------------------------------------
async def verify_firebase_token(token: str) -> Optional[dict]:
    """
    Verifies a Firebase ID token. Returns decoded token claims or None on failure.
    If Firebase is not configured, returns a guest identity so the app still works locally.
    """
    if not token:
        return None
    try:
        from firebase_admin import auth

        decoded = auth.verify_id_token(token)
        return decoded
    except Exception as e:
        logger.warning(f"Token verification failed: {e}")
        return None


def _extract_bearer(authorization: str) -> str:
    return authorization.replace("Bearer ", "").replace("bearer ", "").strip()


# ---------------------------------------------------------------------------
# Firestore helpers
# ---------------------------------------------------------------------------
def _save_panel_to_firestore(uid: str, project_id: str, panel_number: int, data: dict):
    """Persist a generated panel to Firestore (non-blocking best-effort)."""
    if _db is None:
        return
    try:
        _db.collection("users").document(uid).collection("projects").document(project_id).collection("panels").document(
            str(panel_number)
        ).set(data)
    except Exception as e:
        logger.warning(f"Firestore panel save failed: {e}")


def _save_session_meta_to_firestore(uid: str, project_id: str, data: dict):
    """Persist session metadata (story title, scene count, style) to Firestore."""
    if _db is None:
        return
    try:
        _db.collection("users").document(uid).collection("projects").document(project_id).set(data, merge=True)
    except Exception as e:
        logger.warning(f"Firestore session meta save failed: {e}")


def _save_full_session_to_firestore(uid: str, project_id: str, session_data: dict):
    """Persist full session state to Firestore for resumption across restarts."""
    if _db is None:
        return
    try:
        doc = {
            "filename": session_data.get("filename", ""),
            "story_text": session_data.get("story_text", ""),
            "current_style": session_data.get("current_style", "american"),
            "current_scene_index": session_data.get("current_scene_index", 0),
            "scene_count": len(session_data.get("scenes", [])),
            "status": session_data.get("status", "uploaded"),
            "uid": uid,
            "updated_at": _firestore_timestamp(),
        }
        _db.collection("users").document(uid).collection("projects").document(project_id).set(doc, merge=True)
    except Exception as e:
        logger.warning(f"Firestore full session save failed: {e}")


def _load_session_from_firestore(uid: str, project_id: str) -> Optional[Dict]:
    """Load a session from Firestore. Returns session dict or None."""
    if _db is None:
        return None
    try:
        doc_ref = _db.collection("users").document(uid).collection("projects").document(project_id)
        doc = doc_ref.get()
        if not doc.exists:
            return None
        data = doc.to_dict()

        # Load panels subcollection
        panels = []
        panels_ref = doc_ref.collection("panels").order_by("panel_number").stream()
        for panel_doc in panels_ref:
            panels.append(panel_doc.to_dict())

        story_text = data.get("story_text", "")
        from processor import StoryProcessor
        scenes = StoryProcessor.break_into_scenes(story_text) if story_text else []

        return {
            "filename": data.get("filename", ""),
            "status": data.get("status", "uploaded"),
            "story_text": story_text,
            "scenes": scenes,
            "current_scene_index": data.get("current_scene_index", 0),
            "current_style": data.get("current_style", "american"),
            "panels": panels,
            "uid": uid,
            "project_id": project_id,
        }
    except Exception as e:
        logger.warning(f"Firestore session load failed: {e}")
        return None


# ---------------------------------------------------------------------------
# In-memory session storage (backed by Firestore when available)
# ---------------------------------------------------------------------------
sessions: Dict[str, Dict] = {}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
async def root():
    return {"message": "Enpitsu Backend is running"}


@app.post("/upload")
async def upload_story(
    file: UploadFile = File(...),
    authorization: str = Header(default=""),
):
    """
    Accepts PDF/DOCX uploads, extracts text, initialises a session.
    Authorization header (Bearer <firebase_idToken>) is optional but
    enables Firestore persistence when provided.
    """
    filename = file.filename or ""
    if not filename.lower().endswith((".pdf", ".docx")):
        raise HTTPException(status_code=400, detail="Only PDF and DOCX files are supported.")

    # Verify token if provided (non-blocking — guests still work)
    uid = "anonymous"
    if authorization:
        token = _extract_bearer(authorization)
        decoded = await verify_firebase_token(token)
        if decoded:
            uid = decoded["uid"]

    content = await file.read()
    text = await StoryProcessor.extract_text(content, filename)

    if not text:
        raise HTTPException(status_code=400, detail="Could not extract text from file.")

    session_id = str(uuid.uuid4())
    scenes = StoryProcessor.break_into_scenes(text)

    sessions[session_id] = {
        "filename": filename,
        "status": "uploaded",
        "story_text": text,
        "scenes": scenes,
        "current_scene_index": 0,
        "current_style": "american",
        "panels": [],
        "uid": uid,
        "project_id": session_id,
    }

    # Persist full session to Firestore (includes story_text for resumption)
    _save_full_session_to_firestore(uid, session_id, sessions[session_id])
    _save_session_meta_to_firestore(
        uid,
        session_id,
        {
            "filename": filename,
            "scene_count": len(scenes),
            "style": "american",
            "created_at": _firestore_timestamp(),
        },
    )

    logger.info(f"Session created: {session_id} | file: {filename} | uid: {uid} | scenes: {len(scenes)}")

    return {
        "session_id": session_id,
        "filename": filename,
        "scene_count": len(scenes),
    }


def _firestore_timestamp():
    """Returns a server timestamp sentinel if Firestore is available, else None."""
    try:
        from firebase_admin import firestore

        return firestore.SERVER_TIMESTAMP  # type: ignore[attr-defined]
    except Exception:
        return None


@app.get("/session/{session_id}")
async def get_session(session_id: str):
    """Returns current session state."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found.")
    session = sessions[session_id]
    return {
        "session_id": session_id,
        "filename": session["filename"],
        "status": session["status"],
        "scene_count": len(session["scenes"]),
        "current_scene_index": session["current_scene_index"],
        "current_style": session["current_style"],
        "panel_count": len(session["panels"]),
    }


@app.get("/session/{session_id}/panels")
async def get_panels(session_id: str):
    """Returns all generated panels for a session."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found.")
    return {"panels": sessions[session_id]["panels"]}


@app.post("/session/{project_id}/resume")
async def resume_session(
    project_id: str,
    authorization: str = Header(default=""),
):
    """
    Resume a previously saved session from Firestore.
    Returns a new session_id (which reuses the project_id) that can be used
    with the WebSocket endpoint.
    """
    uid = "anonymous"
    if authorization:
        token = _extract_bearer(authorization)
        decoded = await verify_firebase_token(token)
        if decoded:
            uid = decoded["uid"]

    # Check if already in memory
    if project_id in sessions:
        session = sessions[project_id]
        return {
            "session_id": project_id,
            "filename": session["filename"],
            "scene_count": len(session["scenes"]),
            "panel_count": len(session["panels"]),
            "restored_from": "memory",
        }

    # Try loading from Firestore
    session_data = _load_session_from_firestore(uid, project_id)
    if not session_data:
        raise HTTPException(status_code=404, detail="Session not found in Firestore.")

    sessions[project_id] = session_data
    logger.info(
        f"Session restored from Firestore: {project_id} | "
        f"panels={len(session_data['panels'])} | uid={uid}"
    )

    return {
        "session_id": project_id,
        "filename": session_data["filename"],
        "scene_count": len(session_data["scenes"]),
        "panel_count": len(session_data["panels"]),
        "restored_from": "firestore",
    }


# ---------------------------------------------------------------------------
# WebSocket — real-time agent streaming
# ---------------------------------------------------------------------------
@app.websocket("/ws/session/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str, token: str = ""):
    """
    WebSocket endpoint for real-time bidirectional streaming with the Gemini agent.

    Incoming message types (from frontend):
      - { "type": "user_message", "text": "..." }
      - { "type": "style_update", "style": "manga|american|..." }
      - { "type": "audio_turn_complete" }
      - binary bytes: raw PCM audio chunks (16-bit signed, 16kHz, mono)

    Outgoing message types (to frontend):
      - { "type": "agent_response", "text": "...", "status": "speaking" }
      - { "type": "agent_audio", "audio": "<base64 PCM>", "mime_type": "..." }
      - { "type": "status_update", "status": "generating|thinking|idle", "text": "..." }
      - { "type": "panel_loading", "panel_number": N, "caption": "..." }
      - { "type": "panel_generated", "image": "<base64 JPEG>", "prompt": "...", "text": "...", "panel_number": N }
      - { "type": "panel_updated", "image": "<base64 JPEG>", "panel_number": N, "text": "..." }
      - { "type": "ping" }
      - { "type": "error", "message": "..." }
    """
    if session_id not in sessions:
        await websocket.close(code=4004)
        return

    # Verify token from query param if provided
    uid = "anonymous"
    if token:
        decoded = await verify_firebase_token(token)
        if decoded:
            uid = decoded["uid"]
            logger.info(f"Authenticated WebSocket | uid={uid} | session={session_id}")
        else:
            logger.warning(f"Invalid token on WebSocket connect | session={session_id}")

    await websocket.accept()
    logger.info(f"WebSocket accepted | session={session_id} | uid={uid}")

    session_data = sessions[session_id]

    try:
        agent = GeminiAgent()
        image_gen = ImageGenerator()
    except RuntimeError as e:
        logger.error(f"Auth configuration error: {e}")
        await websocket.send_json({"type": "error", "message": "Server misconfiguration: no API credentials."})
        await websocket.close(code=1011)
        return

    # -------------------------------------------------------------------
    # WebSocket send guard — prevents "send after close" errors
    # -------------------------------------------------------------------
    ws_closed = False

    async def safe_send(data: dict):
        """Send JSON to the WebSocket, silently ignoring if already closed."""
        if ws_closed:
            return
        try:
            await websocket.send_json(data)
        except Exception:
            pass  # WebSocket already closed — nothing to do

    # -------------------------------------------------------------------
    # Tool response batching — accumulate generate_comic_panel responses
    # and send them all at once after a debounce window. This prevents
    # Gemini from speaking between panels when it sends tool calls one at a time.
    # -------------------------------------------------------------------
    pending_tool_responses: list[tuple[str, str, dict]] = []
    tool_generation_tasks: list[asyncio.Task] = []
    tool_batch_timer: list[Optional[asyncio.Task]] = [None]  # mutable container

    async def _flush_tool_responses():
        """Send all accumulated tool responses to Gemini at once."""
        if not pending_tool_responses:
            return
        responses = list(pending_tool_responses)
        pending_tool_responses.clear()
        logger.info(f"Flushing {len(responses)} batched tool responses to Gemini")
        await agent.send_tool_responses_batch(responses)

    async def _schedule_tool_flush(delay: float = 2.0):
        """Wait for more tool calls, then flush. Cancelled if new calls arrive."""
        await asyncio.sleep(delay)
        # Wait for any in-progress image generation tasks
        if tool_generation_tasks:
            await asyncio.gather(*tool_generation_tasks, return_exceptions=True)
            tool_generation_tasks.clear()
        await _flush_tool_responses()

    # -------------------------------------------------------------------
    # Transcription buffer — accumulate chunks until turn_complete
    # -------------------------------------------------------------------
    transcription_buffer: list[str] = []
    initial_style_sent = False  # first style_update is just a sync, don't notify Gemini

    async def flush_transcription():
        """
        Fallback: process accumulated GENERATE_PANEL: tokens from transcription.
        This only fires if the model doesn't use function calling (e.g. old SDK version).
        """
        nonlocal transcription_buffer
        full_text = " ".join(transcription_buffer).strip()
        transcription_buffer = []
        if not full_text:
            return

        logger.info(f"Agent transcription (flush): {full_text[:200]}")

        # Normalise any garbled token
        normalised = re.sub(r"GEN\s*ERATE\s*_\s*PANEL\s*:", "GENERATE_PANEL:", full_text, flags=re.IGNORECASE)
        normalised = re.sub(r"CAP\s*TION\s*:", "CAPTION:", normalised, flags=re.IGNORECASE)

        if "GENERATE_PANEL:" not in normalised:
            await safe_send({"type": "agent_response", "text": normalised, "status": "speaking"})
            await safe_send({"type": "status_update", "status": "idle", "text": "Ready."})
            return

        parts = normalised.split("GENERATE_PANEL:")
        intro = parts[0].strip()
        if intro:
            await safe_send({"type": "agent_response", "text": intro, "status": "speaking"})

        base_number = len(session_data["panels"]) + 1
        panel_specs = []
        for i, part in enumerate(parts[1:]):
            raw = part.strip().replace("\n", " ")
            if "CAPTION:" in raw:
                prompt, caption = raw.split("CAPTION:", 1)
                prompt, caption = prompt.strip(), caption.strip()
            else:
                prompt, caption = raw, f"Panel {base_number + i}"
            panel_specs.append((base_number + i, prompt, caption))

        for panel_number, _, caption in panel_specs:
            await safe_send({"type": "panel_loading", "panel_number": panel_number, "caption": caption})
        await safe_send(
            {"type": "status_update", "status": "generating", "text": f"Drawing {len(panel_specs)} panel(s)..."}
        )

        async def _gen(panel_number: int, prompt: str, caption: str):
            style = session_data.get("current_style", "american")
            image_b64 = await image_gen.generate_panel(prompt, style=style)
            if image_b64:
                session_data["panels"].append(
                    {
                        "panel_number": panel_number,
                        "prompt": prompt,
                        "image": image_b64,
                        "caption": caption,
                        "style": style,
                        "scene_index": session_data["current_scene_index"],
                    }
                )
                _save_panel_to_firestore(
                    session_data["uid"],
                    session_data["project_id"],
                    panel_number,
                    {
                        "prompt": prompt,
                        "caption": caption,
                        "style": style,
                        "panel_number": panel_number,
                        "created_at": _firestore_timestamp(),
                    },
                )
                await safe_send(
                    {
                        "type": "panel_generated",
                        "image": image_b64,
                        "prompt": prompt,
                        "text": caption,
                        "panel_number": panel_number,
                    }
                )
            else:
                await safe_send(
                    {
                        "type": "panel_failed",
                        "panel_number": panel_number,
                        "message": f"Panel {panel_number} failed — ask me to retry.",
                    }
                )

        await asyncio.gather(*[_gen(n, p, c) for n, p, c in panel_specs])
        await safe_send({"type": "status_update", "status": "idle", "text": "Ready."})

    # -------------------------------------------------------------------
    # on_agent_message — handles all messages from Gemini Live API
    # -------------------------------------------------------------------
    async def on_agent_message(message):
        try:
            # --- Tool calls (structured function calling) ---
            tool_call = getattr(message, "tool_call", None)
            if tool_call and tool_call.function_calls:
                # Assign panel numbers up-front (before any async work) so
                # concurrent tasks get stable, non-colliding numbers.
                panel_counter = [len(session_data["panels"])]

                async def _handle_generate(fc, panel_number: int) -> tuple[str, str, dict]:
                    """Generate one panel, send UI updates, return the tool response tuple."""
                    prompt = (fc.args or {}).get("visual_description", "")
                    caption = (fc.args or {}).get("caption", "")
                    style = session_data.get("current_style", "american")

                    logger.info(f"Tool call: {fc.name} | panel={panel_number} | args={fc.args}")
                    await safe_send(
                        {"type": "panel_loading", "panel_number": panel_number, "caption": caption}
                    )
                    await safe_send(
                        {"type": "status_update", "status": "generating", "text": f"Drawing panel {panel_number}..."}
                    )

                    image_b64 = await image_gen.generate_panel(prompt, style=style)
                    if image_b64:
                        session_data["panels"].append(
                            {
                                "panel_number": panel_number,
                                "prompt": prompt,
                                "image": image_b64,
                                "caption": caption,
                                "style": style,
                                "scene_index": session_data["current_scene_index"],
                            }
                        )
                        _save_panel_to_firestore(
                            session_data["uid"],
                            session_data["project_id"],
                            panel_number,
                            {
                                "prompt": prompt,
                                "caption": caption,
                                "style": style,
                                "panel_number": panel_number,
                                "created_at": _firestore_timestamp(),
                            },
                        )
                        await safe_send(
                            {
                                "type": "panel_generated",
                                "image": image_b64,
                                "prompt": prompt,
                                "text": caption,
                                "panel_number": panel_number,
                            }
                        )
                        await safe_send({"type": "status_update", "status": "idle", "text": "Ready."})
                        return (fc.id or "", fc.name, {"status": "success", "panel_number": panel_number})
                    else:
                        await safe_send(
                            {
                                "type": "panel_failed",
                                "panel_number": panel_number,
                                "message": f"Panel {panel_number} generation failed — ask me to retry.",
                            }
                        )
                        await safe_send({"type": "status_update", "status": "idle", "text": "Ready."})
                        return (fc.id or "", fc.name, {
                            "status": "error",
                            "message": "Image generation was blocked by safety filters. "
                            "Rewrite the visual_description to avoid depicting violence, "
                            "weapons, or aggressive physical contact. Focus on emotions, "
                            "expressions, and implied tension instead of explicit actions."
                        })

                async def _handle_edit(fc) -> tuple[str, str, dict]:
                    """Edit one panel, send UI updates, return the tool response tuple."""
                    panel_number = int((fc.args or {}).get("panel_number", 0))
                    new_description = (fc.args or {}).get("new_description", "")
                    new_caption = (fc.args or {}).get("new_caption", "")
                    style = session_data.get("current_style", "american")

                    logger.info(f"Tool call: {fc.name} | panel={panel_number} | args={fc.args}")
                    await safe_send(
                        {"type": "status_update", "status": "generating", "text": f"Redrawing panel {panel_number}..."}
                    )

                    image_b64 = await image_gen.generate_panel(new_description, style=style)
                    if image_b64:
                        for p in session_data["panels"]:
                            if p.get("panel_number") == panel_number:
                                p["image"] = image_b64
                                p["prompt"] = new_description
                                p["caption"] = new_caption
                        _save_panel_to_firestore(
                            session_data["uid"],
                            session_data["project_id"],
                            panel_number,
                            {
                                "prompt": new_description,
                                "caption": new_caption,
                                "style": style,
                                "panel_number": panel_number,
                                "updated_at": _firestore_timestamp(),
                            },
                        )
                        await safe_send(
                            {
                                "type": "panel_updated",
                                "panel_number": panel_number,
                                "image": image_b64,
                                "text": new_caption,
                                "prompt": new_description,
                            }
                        )
                        await safe_send({"type": "status_update", "status": "idle", "text": "Ready."})
                        return (fc.id or "", fc.name, {"status": "success", "panel_number": panel_number})
                    else:
                        await safe_send(
                            {"type": "agent_response", "text": f"Couldn't redraw panel {panel_number}.", "status": "idle"}
                        )
                        await safe_send({"type": "status_update", "status": "idle", "text": "Ready."})
                        return (fc.id or "", fc.name, {"status": "error", "message": "Image generation failed"})

                # Build concurrent tasks — one per function call
                generate_tasks = []
                immediate_responses = []  # non-generate responses sent immediately
                for fc in tool_call.function_calls:
                    if fc.name == "update_specific_line":
                        old_text = (fc.args or {}).get("old_text", "")
                        new_text = (fc.args or {}).get("new_text", "")
                        logger.info(f"Tool call: update_specific_line | old={old_text[:60]} | new={new_text[:60]}")
                        story = session_data.get("story_text", "")
                        if old_text and old_text in story:
                            session_data["story_text"] = story.replace(old_text, new_text, 1)
                            await safe_send({
                                "type": "update_line",
                                "old": old_text,
                                "new": new_text,
                            })
                            # Persist updated story text to Firestore
                            _save_full_session_to_firestore(
                                session_data["uid"], session_data["project_id"], session_data
                            )
                            immediate_responses.append(
                                (fc.id or "", fc.name, {"status": "success", "message": "Text updated."})
                            )
                        else:
                            immediate_responses.append(
                                (fc.id or "", fc.name, {"status": "error", "message": "old_text not found in story."})
                            )
                    elif fc.name == "play_music_during_wait":
                        music_type = (fc.args or {}).get("music_type", "calm")
                        logger.info(f"Tool call: play_music_during_wait | type={music_type}")
                        await safe_send({
                            "type": "play_music",
                            "music_type": music_type,
                        })
                        immediate_responses.append(
                            (fc.id or "", fc.name, {"status": "success", "message": f"Playing {music_type} music."})
                        )
                    elif fc.name == "generate_comic_panel":
                        panel_counter[0] += 1

                        async def _gen_and_queue(fc_ref, pn):
                            result = await _handle_generate(fc_ref, pn)
                            pending_tool_responses.append(result)

                        task = asyncio.create_task(_gen_and_queue(fc, panel_counter[0]))
                        generate_tasks.append(task)
                        tool_generation_tasks.append(task)
                    elif fc.name == "edit_existing_panel":
                        result = await _handle_edit(fc)
                        immediate_responses.append(result)
                    elif fc.name == "clear_all_panels":
                        reason = (fc.args or {}).get("reason", "")
                        logger.info(f"Tool call: clear_all_panels | reason={reason}")
                        panel_count = len(session_data["panels"])
                        session_data["panels"] = []
                        await safe_send({"type": "panels_cleared"})
                        await safe_send(
                            {"type": "status_update", "status": "idle", "text": f"Cleared {panel_count} panels."}
                        )
                        immediate_responses.append(
                            (fc.id or "", fc.name, {"status": "success", "panels_cleared": panel_count})
                        )

                # Send non-generate responses immediately
                if immediate_responses:
                    await agent.send_tool_responses_batch(immediate_responses)

                # For generate calls: use debounce batching.
                # Cancel any existing flush timer and restart it — this lets us
                # accumulate tool calls that Gemini sends one at a time.
                if generate_tasks:
                    if tool_batch_timer[0] and not tool_batch_timer[0].done():
                        tool_batch_timer[0].cancel()
                    tool_batch_timer[0] = asyncio.create_task(_schedule_tool_flush(3.0))

                return  # tool call handled — don't process server_content below

            # --- server_content: audio + transcription ---
            sc = getattr(message, "server_content", None)
            if not sc:
                return

            # Suppress Gemini speech while panels are being generated —
            # prevents the AI from talking between individual panel generations
            is_generating = bool(pending_tool_responses) or bool(tool_generation_tasks)

            # Log user speech (input transcription) and record in history
            input_tr = getattr(sc, "input_transcription", None)
            if input_tr and getattr(input_tr, "text", None):
                logger.info(f"User said: {input_tr.text}")

            # Accumulate agent output transcription (fallback GENERATE_PANEL path)
            output_tr = getattr(sc, "output_transcription", None)
            if output_tr and getattr(output_tr, "text", None):
                transcription_buffer.append(output_tr.text)

            # Forward audio chunks to frontend (suppress while generating panels)
            model_turn = getattr(sc, "model_turn", None)
            if model_turn and not is_generating:
                for part in getattr(model_turn, "parts", []):
                    inline_data = getattr(part, "inline_data", None)
                    if inline_data and getattr(inline_data, "data", None):
                        audio_b64 = base64.b64encode(inline_data.data).decode("utf-8")
                        await safe_send(
                            {
                                "type": "agent_audio",
                                "audio": audio_b64,
                                "mime_type": getattr(inline_data, "mime_type", "audio/pcm;rate=24000"),
                            }
                        )

            # Forward interrupted event — frontend uses this to clear audio queue
            if getattr(sc, "interrupted", False):
                await safe_send({"type": "interrupted"})
                logger.info("Gemini interrupted signal forwarded to frontend")

            # Flush transcription buffer when Gemini signals turn complete
            turn_done = getattr(sc, "turn_complete", False) or getattr(message, "turn_complete", False)
            if turn_done:
                await flush_transcription()

        except Exception as e:
            logger.error(f"Error in on_agent_message: {e}", exc_info=True)

    # -------------------------------------------------------------------
    # Build system instruction and start agent
    # -------------------------------------------------------------------
    system_instruction = agent.get_system_instruction(session_data["story_text"])

    agent_task = asyncio.create_task(agent.connect(system_instruction, on_agent_message))

    # -------------------------------------------------------------------
    # Heartbeat — keeps the WebSocket alive during long operations
    # -------------------------------------------------------------------
    async def heartbeat():
        while True:
            await asyncio.sleep(30)
            try:
                await websocket.send_json({"type": "ping"})
            except Exception:
                break

    heartbeat_task = asyncio.create_task(heartbeat())

    # Send greeting AFTER Gemini session is confirmed open — otherwise the
    # message arrives before the session is ready and gets dropped.
    async def _send_greeting():
        try:
            await agent.wait_until_ready(timeout=15.0)
            await agent.send_text(
                "Greet the user warmly. You are Enpitsu, their AI comic co-creator. "
                "Tell them you've read their story. Ask what art style they'd like and which scene to start with. "
                "Keep it to 2-3 sentences, spoken naturally."
            )
            logger.info("Greeting sent to Gemini after session ready")
        except asyncio.TimeoutError:
            logger.warning("Timed out waiting for Gemini session — skipping greeting")
        except Exception as e:
            logger.error(f"Greeting send failed: {e}")

    asyncio.create_task(_send_greeting())

    await websocket.send_json({"type": "status_update", "status": "thinking", "text": "Connecting..."})

    # Send story text to frontend for the editor
    await websocket.send_json({
        "type": "push_story",
        "text": session_data.get("story_text", ""),
    })

    # -------------------------------------------------------------------
    # Main receive loop
    # -------------------------------------------------------------------
    try:
        while True:
            message = await websocket.receive()

            # Handle WebSocket disconnect message
            if message.get("type") == "websocket.disconnect":
                logger.info(f"Client sent disconnect | session={session_id}")
                break

            if "text" in message:
                try:
                    data = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue

                msg_type = data.get("type")
                logger.info(f"Received [{msg_type}] | session={session_id}")

                if msg_type == "user_message":
                    await flush_transcription()
                    await agent.send_text(data.get("text", ""))

                elif msg_type == "audio_turn_complete":
                    logger.info("Audio turn complete — calling send_audio_end()")
                    try:
                        await agent.send_audio_end()
                    except Exception as e:
                        logger.error(f"send_audio_end failed: {e}")

                elif msg_type == "style_update":
                    new_style = data.get("style", "american")
                    old_style = session_data.get("current_style", "american")
                    session_data["current_style"] = new_style
                    logger.info(f"Style updated to: {new_style}")
                    # Persist style change to Firestore
                    _save_session_meta_to_firestore(
                        session_data["uid"], session_data["project_id"],
                        {"current_style": new_style, "updated_at": _firestore_timestamp()},
                    )
                    if not initial_style_sent:
                        initial_style_sent = True
                    elif new_style != old_style:
                        # Only notify Gemini when the style actually changed
                        await agent.send_text(
                            f"[System: The art style has been changed to '{new_style}'. "
                            f"Acknowledge in one short sentence. Do NOT generate any panels right now.]"
                        )

            elif "bytes" in message:
                audio_bytes = message["bytes"]
                await agent.send_audio(audio_bytes)

    except WebSocketDisconnect:
        logger.info(f"Client disconnected | session={session_id}")
    except Exception as e:
        logger.error(f"WebSocket error | session={session_id}: {e}", exc_info=True)
    finally:
        ws_closed = True
        agent._stop = True
        agent_task.cancel()
        heartbeat_task.cancel()
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
