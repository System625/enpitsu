import os
import uuid
import asyncio
import json
import logging
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
        "current_style": "Manga",
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

    async def on_agent_message(message):
        """Callback: handles LiveServerMessage from Gemini and forwards to frontend."""
        try:
            # LiveServerMessage structure: message.server_content.model_turn.parts
            sc = getattr(message, 'server_content', None)
            if not sc:
                return

            # Output audio transcription (text of what agent is saying)
            transcription = getattr(sc, 'output_transcription', None)
            if transcription and getattr(transcription, 'text', None):
                text = transcription.text
                if "GENERATE_PANEL:" in text:
                    msg_parts = text.split("GENERATE_PANEL:", 1)
                    pre_text = msg_parts[0].strip()
                    prompt = msg_parts[1].strip()
                    if pre_text:
                        await websocket.send_json({"type": "agent_response", "text": pre_text, "status": "speaking"})
                    await websocket.send_json({"type": "status_update", "status": "generating", "text": f"Generating panel: {prompt}..."})
                    image_b64 = await image_gen.generate_panel(prompt, style=session_data.get("current_style", "Manga"))
                    if image_b64:
                        session_data["panels"].append({"prompt": prompt, "image": image_b64, "style": session_data.get("current_style", "Manga"), "scene_index": session_data["current_scene_index"]})
                        await websocket.send_json({"type": "panel_generated", "image": image_b64, "prompt": prompt, "text": pre_text})
                    else:
                        await websocket.send_json({"type": "agent_response", "text": "Panel generation failed, let's try again.", "status": "idle"})
                else:
                    await websocket.send_json({"type": "agent_response", "text": text, "status": "speaking"})

            # Audio chunks from model_turn.parts
            model_turn = getattr(sc, 'model_turn', None)
            if model_turn:
                import base64
                for part in (model_turn.parts or []):
                    if hasattr(part, 'inline_data') and part.inline_data and part.inline_data.data:
                        audio_b64 = base64.b64encode(part.inline_data.data).decode('utf-8')
                        await websocket.send_json({
                            "type": "agent_audio",
                            "audio": audio_b64,
                            "mime_type": part.inline_data.mime_type,
                        })

        except Exception as e:
            logger.error(f"Error forwarding agent message: {e}")

    # Build system instruction
    system_instruction = agent.get_system_instruction(session_data['story_text'])
    system_instruction += (
        "\nWhen you want to generate a comic panel, output 'GENERATE_PANEL: [short visual description]' "
        "at the end of your response. Keep the description concise and visual.\n"
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
                    await agent.send_text(data.get("text", ""))

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
