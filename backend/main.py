import re
import uuid
import asyncio
import json
import logging
import base64
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict
from dotenv import load_dotenv

from processor import StoryProcessor
from agent import GeminiAgent
from image_gen import ImageGenerator

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Enpitsu Backend")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session storage (use Redis/DB for production)
sessions: Dict[str, Dict] = {}


@app.get("/")
async def root():
    return {"message": "Enpitsu Backend is running"}


@app.post("/upload")
async def upload_story(file: UploadFile = File(...)):
    """
    Accepts PDF/Word file uploads, extracts text, and initializes a session.
    """
    if not file.filename.lower().endswith(('.pdf', '.docx')):
        raise HTTPException(status_code=400, detail="Only PDF and DOCX files are supported.")

    content = await file.read()
    text = await StoryProcessor.extract_text(content, file.filename)

    if not text:
        raise HTTPException(status_code=400, detail="Could not extract text from file.")

    session_id = str(uuid.uuid4())
    scenes = StoryProcessor.break_into_scenes(text)

    sessions[session_id] = {
        "filename": file.filename,
        "status": "uploaded",
        "story_text": text,
        "scenes": scenes,
        "current_scene_index": 0,
        "current_style": "American",
        "panels": [],
    }

    logger.info(f"Session created: {session_id} for file: {file.filename}. Extracted {len(scenes)} scenes.")

    return {
        "session_id": session_id,
        "filename": file.filename,
        "scene_count": len(scenes),
    }


@app.get("/session/{session_id}")
async def get_session(session_id: str):
    """Returns current session state (panels generated so far, scene count, etc.)."""
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


@app.websocket("/ws/session/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """
    WebSocket endpoint for real-time bidirectional streaming with the Gemini agent.

    Incoming message types (from frontend):
      - { "type": "user_message", "text": "..." }
      - { "type": "style_update", "style": "Manga|Manhwa|Western" }
      - binary bytes: raw PCM audio chunks from the user's microphone

    Outgoing message types (to frontend):
      - { "type": "agent_response", "text": "...", "status": "speaking" }
      - { "type": "agent_audio", "audio": "<base64 PCM>" }
      - { "type": "status_update", "status": "generating|thinking|idle", "text": "..." }
      - { "type": "panel_generated", "image": "<base64 JPEG>", "prompt": "...", "text": "..." }
      - { "type": "error", "message": "..." }
    """
    if session_id not in sessions:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    logger.info(f"WebSocket connection accepted for session: {session_id}")

    session_data = sessions[session_id]

    try:
        agent = GeminiAgent()
        image_gen = ImageGenerator()
    except RuntimeError as e:
        logger.error(f"Auth configuration error: {e}")
        await websocket.send_json({"type": "error", "message": "Server misconfiguration: no API credentials."})
        await websocket.close(code=1011)
        return

    # Accumulate transcription chunks across a full agent turn
    transcription_buffer = []

    async def flush_transcription():
        """Process the accumulated transcription buffer as a complete turn."""
        nonlocal transcription_buffer
        full_text = " ".join(transcription_buffer).strip()
        transcription_buffer = []
        if not full_text:
            return

        logger.info(f"Agent transcription: {full_text}")

        # Normalise transcription artifacts: Gemini sometimes inserts spaces inside tokens
        # e.g. "GEN ERATE_PANEL:" or "GENERATE_ PANEL:" → "GENERATE_PANEL:"
        normalised_text = re.sub(r'GEN\s*ERATE\s*_\s*PANEL\s*:', 'GENERATE_PANEL:', full_text, flags=re.IGNORECASE)
        normalised_text = re.sub(r'CAP\s*TION\s*:', 'CAPTION:', normalised_text, flags=re.IGNORECASE)
        full_text = normalised_text

        if "GENERATE_PANEL:" in full_text:
            # Split on every GENERATE_PANEL: token to support multiple panels per turn
            # Format: [narrative_text, prompt1, narrative_text2, prompt2, ...]
            parts = full_text.split("GENERATE_PANEL:")
            intro_text = parts[0].strip()
            if intro_text:
                await websocket.send_json({"type": "agent_response", "text": intro_text, "status": "speaking"})

            base_panel_number = len(session_data["panels"]) + 1
            panel_specs = []
            for i, panel_part in enumerate(parts[1:]):
                raw = panel_part.strip().replace("\n", " ").strip()
                if "CAPTION:" in raw:
                    caption_split = raw.split("CAPTION:", 1)
                    prompt = caption_split[0].strip()
                    caption = caption_split[1].strip()
                else:
                    prompt = raw
                    caption = f"Panel {base_panel_number + i}"
                panel_specs.append((base_panel_number + i, prompt, caption))

            # Send all skeletons immediately so the canvas fills up at once
            for panel_number, prompt, caption in panel_specs:
                await websocket.send_json({"type": "panel_loading", "panel_number": panel_number, "caption": caption})
            await websocket.send_json({"type": "status_update", "status": "generating", "text": f"Drawing {len(panel_specs)} panel(s)..."})

            # Generate all panels concurrently — images pop in as they finish
            async def generate_and_send(panel_number: int, prompt: str, caption: str):
                style = session_data.get("current_style", "american")
                image_b64 = await image_gen.generate_panel(prompt, style=style)
                if image_b64:
                    session_data["panels"].append({"prompt": prompt, "image": image_b64, "style": style, "scene_index": session_data["current_scene_index"]})
                    await websocket.send_json({"type": "panel_generated", "image": image_b64, "prompt": prompt, "text": caption, "panel_number": panel_number})
                else:
                    await websocket.send_json({"type": "agent_response", "text": f"Panel {panel_number} hit a snag — ask me to retry it.", "status": "idle"})

            await asyncio.gather(*[generate_and_send(n, p, c) for n, p, c in panel_specs])
            await websocket.send_json({"type": "status_update", "status": "idle", "text": "Ready."})
        else:
            await websocket.send_json({"type": "agent_response", "text": full_text, "status": "speaking"})
            await websocket.send_json({"type": "status_update", "status": "idle", "text": "Ready."})

    async def on_agent_message(message):
        """Callback: handles LiveServerMessage from Gemini and forwards to frontend."""
        try:
            sc = getattr(message, 'server_content', None)
            if not sc:
                return

            # Log what the user said (input transcription) for debugging
            input_transcription = getattr(sc, 'input_transcription', None)
            if input_transcription and getattr(input_transcription, 'text', None):
                logger.info(f"User said: {input_transcription.text}")

            # Accumulate agent's output transcription (contains GENERATE_PANEL tokens)
            output_transcription = getattr(sc, 'output_transcription', None)
            if output_transcription and getattr(output_transcription, 'text', None):
                transcription_buffer.append(output_transcription.text)

            # Forward raw audio chunks to the frontend
            model_turn = getattr(sc, 'model_turn', None)
            if model_turn:
                for part in getattr(model_turn, 'parts', []):
                    inline_data = getattr(part, 'inline_data', None)
                    if inline_data and getattr(inline_data, 'data', None):
                        audio_b64 = base64.b64encode(inline_data.data).decode('utf-8')
                        await websocket.send_json({
                            "type": "agent_audio",
                            "audio": audio_b64,
                            "mime_type": getattr(inline_data, 'mime_type', 'audio/pcm;rate=24000'),
                        })

            # turn_complete fires when Gemini finishes its response — flush then
            turn_done = getattr(sc, 'turn_complete', False) or getattr(message, 'turn_complete', False)
            if turn_done:
                await flush_transcription()

        except Exception as e:
            logger.error(f"Error forwarding agent message: {e}")

    # Build system instruction
    system_instruction = agent.get_system_instruction(session_data['story_text'])
    system_instruction += (
        "\n\nCRITICAL PANEL GENERATION RULES:\n"
        "- Every time you want to render a comic panel, output the exact token: GENERATE_PANEL: followed by a visual description, then CAPTION: followed by a punchy in-world line. Everything on ONE line.\n"
        "- NEVER ask the user for style or mood preferences before generating — pick sensible defaults and generate immediately.\n"
        "- If the user asks for multiple panels or to complete the whole story, output ALL panels in a single response, each on its own line.\n"
        "- Format for each panel (ONE line, no internal line breaks):\n"
        "  GENERATE_PANEL: <visual scene description> CAPTION: <punchy comic dialogue or narration max 10 words>\n"
        "- Examples:\n"
        "  GENERATE_PANEL: Dark rooftop at night, lone figure in a trench coat CAPTION: The city never sleeps. Neither do I.\n"
        "  GENERATE_PANEL: Hero leaps across rooftops, city lights below CAPTION: Nowhere to run, Vasquez!\n"
        "  GENERATE_PANEL: Villain revealed in shadowy lair CAPTION: I've been expecting you.\n"
        "- The CAPTION must be authentic comic book text — character dialogue, internal monologue, or dramatic narration. Never describe the image.\n"
        "- If the user asks for the next panel, generate it immediately without asking questions.\n"
    )

    # Start Gemini live session in background
    agent_task = asyncio.create_task(agent.connect(system_instruction, on_agent_message))

    # Send initial status so frontend knows we're ready
    await websocket.send_json({"type": "status_update", "status": "idle", "text": "Agent ready."})

    try:
        while True:
            message = await websocket.receive()

            if "text" in message:
                data = json.loads(message["text"])
                msg_type = data.get("type")
                logger.info(f"Received [{msg_type}] from session {session_id}")

                if msg_type == "user_message":
                    # Flush any buffered transcription from the previous turn before sending new input
                    await flush_transcription()
                    await agent.send_text(data.get("text", ""))

                elif msg_type == "audio_turn_complete":
                    # Frontend stopped the mic — tell Gemini to start responding
                    await agent.send_audio_end()

                elif msg_type == "style_update":
                    new_style = data.get("style", "Manga")
                    session_data["current_style"] = new_style
                    await agent.send_text(f"The user has selected a new art style: {new_style}. Acknowledge and continue.")

            elif "bytes" in message:
                await agent.send_audio(message["bytes"])

    except WebSocketDisconnect:
        logger.info(f"Client disconnected from session: {session_id}")
    except Exception as e:
        logger.error(f"WebSocket error in session {session_id}: {e}")
    finally:
        agent_task.cancel()
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
