import asyncio
import base64
import json
import logging
import os
import uuid
from typing import Dict, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from image_gen import ImageGenerator, QuotaExceededError
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


@app.post("/session/new")
async def new_session(
    authorization: str = Header(default=""),
):
    """
    Creates an empty session without requiring a file upload.
    Allows users to start chatting with the agent before uploading a story.
    """
    uid = "anonymous"
    if authorization:
        token = _extract_bearer(authorization)
        decoded = await verify_firebase_token(token)
        if decoded:
            uid = decoded["uid"]

    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "filename": "",
        "status": "new",
        "story_text": "",
        "scenes": [],
        "current_scene_index": 0,
        "current_style": "american",
        "panels": [],
        "uid": uid,
        "project_id": session_id,
    }

    logger.info(f"Empty session created: {session_id} | uid={uid}")
    return {"session_id": session_id}


@app.post("/upload")
async def upload_story(
    file: UploadFile = File(...),
    authorization: str = Header(default=""),
    existing_session_id: str = Header(default="", alias="X-Session-Id"),
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

    scenes = StoryProcessor.break_into_scenes(text)

    # If the client already has an active session, update it in-place so we
    # don't force a reconnect (which would cause a redundant re-greeting).
    if existing_session_id and existing_session_id in sessions:
        session_id = existing_session_id
        sessions[session_id].update({
            "filename": filename,
            "status": "uploaded",
            "story_text": text,
            "scenes": scenes,
            "current_scene_index": 0,
        })
        logger.info(f"Story injected into existing session: {session_id} | file: {filename} | scenes: {len(scenes)}")
        return {
            "session_id": session_id,
            "filename": filename,
            "scene_count": len(scenes),
            "reused_session": True,
        }

    session_id = str(uuid.uuid4())
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
        "reused_session": False,
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
    logger.info(f"Session restored from Firestore: {project_id} | panels={len(session_data['panels'])} | uid={uid}")

    return {
        "session_id": project_id,
        "filename": session_data["filename"],
        "scene_count": len(session_data["scenes"]),
        "panel_count": len(session_data["panels"]),
        "restored_from": "firestore",
    }


# ---------------------------------------------------------------------------
# LiveKit Token generation
# ---------------------------------------------------------------------------
@app.post("/livekit/token")
async def get_livekit_token(
    session_id: str,
    token: str = Header(default="", alias="Authorization")
):
    """
    Generate a LiveKit token for the given session.
    """
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found.")
    
    uid = "anonymous"
    if token:
        clean_token = _extract_bearer(token)
        decoded = await verify_firebase_token(clean_token)
        if decoded:
            uid = decoded["uid"]
    
    from livekit.api import AccessToken, VideoGrants
    
    session_data = sessions[session_id]
    
    # Store session state in token metadata so the worker can pick it up
    import json
    metadata = json.dumps({
        "story_text": session_data.get("story_text", ""),
        "current_style": session_data.get("current_style", "american"),
        "panels": session_data.get("panels", []),
        "current_scene_index": session_data.get("current_scene_index", 0),
    })

    lk_token = AccessToken() \
        .with_identity(f"user_{uid}_{uuid.uuid4().hex[:8]}") \
        .with_name(uid) \
        .with_grants(VideoGrants(
            room_join=True,
            room=session_id,
        )) \
        .with_metadata(metadata)
        
    return {"token": lk_token.to_jwt()}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
