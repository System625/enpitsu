import asyncio
import logging
import os
from typing import Callable, Optional

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# Gemini Live API model — 2.5 Flash native audio has better voice quality and responsiveness
LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

# Tool definitions for structured panel generation and editing
COMIC_TOOLS = [
    types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="generate_comic_panel",
                description=(
                    "Generate a comic book panel image from a visual description. "
                    "Call this whenever you want to render a scene as a comic panel."
                ),
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "visual_description": types.Schema(
                            type=types.Type.STRING,
                            description=(
                                "Detailed visual description of the panel: setting, characters, "
                                "action, lighting, composition, camera angle. Include any speech "
                                "bubbles or dialogue as part of the visual description."
                            ),
                        ),
                        "caption": types.Schema(
                            type=types.Type.STRING,
                            description=(
                                "Short narration or dialogue summary for this panel (metadata only, "
                                "not rendered on the image). Max 12 words."
                            ),
                        ),
                    },
                    required=["visual_description", "caption"],
                ),
            ),
            types.FunctionDeclaration(
                name="edit_existing_panel",
                description=(
                    "Regenerate an existing comic panel with new instructions. "
                    "Use when the user asks to change something about a panel that was already created."
                ),
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "panel_number": types.Schema(
                            type=types.Type.INTEGER,
                            description="The 1-based panel number to edit.",
                        ),
                        "new_description": types.Schema(
                            type=types.Type.STRING,
                            description="Updated visual description for the panel.",
                        ),
                        "new_caption": types.Schema(
                            type=types.Type.STRING,
                            description="Updated caption/dialogue for the panel. Max 12 words.",
                        ),
                    },
                    required=["panel_number", "new_description", "new_caption"],
                ),
            ),
        ]
    )
]


def make_client() -> genai.Client:
    """
    Returns a GenAI client. Priority order:
    1. Vertex AI ADC:     GOOGLE_CLOUD_PROJECT set    → genai.Client(vertexai=True, project=..., location=...)
    2. Vertex AI Express: VERTEX_EXPRESS_API_KEY set  → genai.Client(vertexai=True, api_key=...)
    3. AI Studio:         GOOGLE_API_KEY set          → genai.Client(api_key=...)
    """
    project = os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("PROJECT_ID")
    location = os.getenv("GOOGLE_CLOUD_LOCATION") or os.getenv("LOCATION", "us-central1")
    vertex_key = os.getenv("VERTEX_EXPRESS_API_KEY")
    api_key = os.getenv("GOOGLE_API_KEY")

    if project:
        logger.info(f"Using Vertex AI ADC | project={project} location={location}")
        return genai.Client(vertexai=True, project=project, location=location)
    elif vertex_key:
        logger.info("Using Vertex AI Express (API key)")
        return genai.Client(vertexai=True, api_key=vertex_key)
    elif api_key:
        logger.info("Using AI Studio API key auth")
        return genai.Client(api_key=api_key)
    else:
        raise RuntimeError(
            "No auth configured. Set GOOGLE_CLOUD_PROJECT (Vertex AI ADC), "
            "VERTEX_EXPRESS_API_KEY (Vertex Express), or GOOGLE_API_KEY (AI Studio)."
        )


class GeminiAgent:
    """
    Manages a persistent Gemini Live API session using a queue-based architecture.

    Audio, text, and tool inputs are placed into queues. Dedicated async tasks
    drain each queue into the Gemini session independently. The session stays alive
    for the entire conversation — no reconnect-per-turn, no dropped audio.
    """

    def __init__(self, model_id: str = LIVE_MODEL):
        self.model_id = model_id
        self.client = make_client()

        # Input queues — filled by callers, drained by session tasks
        self.audio_input_queue: asyncio.Queue = asyncio.Queue()
        self.text_input_queue: asyncio.Queue = asyncio.Queue()

        # Event queue — filled by receive loop, yielded to on_message callback
        self._event_queue: asyncio.Queue = asyncio.Queue()

        self._stop = False
        self._session: Optional[object] = None
        self._session_ready = asyncio.Event()

    async def connect(self, system_instruction: str, on_message: Callable):
        """
        Opens a persistent Gemini Live API session and routes all events to on_message.
        Returns only when the session ends or self._stop is set.
        """
        config = types.LiveConnectConfig(
            system_instruction=system_instruction,
            response_modalities=["AUDIO"],  # type: ignore[arg-type]
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
                )
            ),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            proactivity=types.ProactivityConfig(proactive_audio=True),  # type: ignore[attr-defined]
            enable_affective_dialog=True,  # type: ignore[call-arg]
            tools=COMIC_TOOLS,
        )

        self._stop = False

        async with self.client.aio.live.connect(model=self.model_id, config=config) as session:
            self._session = session
            self._session_ready.set()
            logger.info(f"Gemini Live session open: {self.model_id}")

            async def _send_audio():
                """Drain audio_input_queue → Gemini."""
                try:
                    while not self._stop:
                        chunk = await self.audio_input_queue.get()
                        if chunk is None:
                            break
                        await session.send_realtime_input(
                            audio=types.Blob(data=chunk, mime_type="audio/pcm;rate=16000")
                        )
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.error(f"send_audio task error: {e}")

            async def _send_text():
                """Drain text_input_queue → Gemini."""
                try:
                    while not self._stop:
                        item = await self.text_input_queue.get()
                        if item is None:
                            break
                        text, turn_complete = item
                        await session.send_client_content(
                            turns=types.Content(role="user", parts=[types.Part(text=text)]),
                            turn_complete=turn_complete,
                        )
                        logger.info(f"Sent text to Gemini: {text[:80]}")
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.error(f"send_text task error: {e}")

            async def _receive_loop():
                """Receive all Gemini events and forward to on_message."""
                try:
                    async for message in session.receive():
                        if self._stop:
                            break
                        await on_message(message)
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    if not self._stop:
                        logger.error(f"receive_loop error: {e}")

            send_audio_task = asyncio.create_task(_send_audio())
            send_text_task = asyncio.create_task(_send_text())
            receive_task = asyncio.create_task(_receive_loop())

            try:
                # Wait until stop is requested
                while not self._stop:
                    await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                pass
            finally:
                self._stop = True
                # Unblock queues
                await self.audio_input_queue.put(None)
                await self.text_input_queue.put(None)
                send_audio_task.cancel()
                send_text_task.cancel()
                receive_task.cancel()
                self._session = None
                self._session_ready.clear()
                logger.info("Gemini Live session closed.")

    async def send_audio(self, audio_data: bytes):
        """Enqueue raw PCM audio chunk (16-bit signed, 16kHz, mono)."""
        if not self._stop:
            await self.audio_input_queue.put(audio_data)

    async def send_audio_end(self):
        """Signal end of user's audio turn (VAD end-of-speech)."""
        if self._session and self._session_ready.is_set():
            logger.info("Sending ActivityEnd to Gemini")
            try:
                await self._session.send_realtime_input(activity_end=types.ActivityEnd())  # type: ignore[attr-defined]
            except Exception as e:
                logger.error(f"send_audio_end error: {e}")

    async def send_text(self, text: str):
        """Enqueue a text turn to be sent to Gemini."""
        if not self._stop:
            await self.text_input_queue.put((text, True))

    async def send_tool_response(self, function_call_id: str, function_name: str, response: dict):
        """Send a tool function response directly back to the active session."""
        if self._session and self._session_ready.is_set():
            try:
                await self._session.send_tool_response(  # type: ignore[attr-defined]
                    function_responses=[
                        types.FunctionResponse(
                            id=function_call_id,
                            name=function_name,
                            response=response,
                        )
                    ]
                )
            except Exception as e:
                logger.error(f"send_tool_response error: {e}")
        else:
            logger.warning("Cannot send tool response — session not active")

    def get_system_instruction(self, story_text: str) -> str:
        """Constructs the Creative Director system prompt with the story injected."""
        return f"""You are Enpitsu, a professional Comic Book Creative Director and AI Co-Creator.
Your goal is to help the user turn their story into a stunning comic book through real-time collaboration.

STORY TEXT:
{story_text}

YOUR RESPONSIBILITIES:
1. Act as a warm, creative collaborator. Use a friendly, professional tone.
2. Respond to the user's voice and text input in real-time. Follow their creative direction.
3. Think in PAGES, not individual panels. Each comic page has 4-6 panels. When generating panels for a scene, call generate_comic_panel() 4-6 times in a row to fill a full page. Vary the compositions:
   - Panel 1: Wide establishing shot (setting, atmosphere)
   - Panels 2-4: Mid-shots and close-ups (dialogue, character reactions, action beats)
   - Panel 5-6: Action shot or cliffhanger that leads to the next page
4. Include speech bubbles and dialogue directly in the visual_description so they are rendered INTO the image (e.g., "speech bubble saying 'Run!'"). The caption field is just a short metadata summary.
5. When the user asks to change or edit an existing panel, call the edit_existing_panel() tool.
6. Keep responses SHORT and action-oriented. Bias toward generating panels, not talking about them.
7. When the user says "generate", "start", "make panels", "illustrate" — IMMEDIATELY call generate_comic_panel() multiple times. Do NOT ask clarifying questions first.
8. When the user changes the art style, acknowledge in 1 sentence. Do NOT regenerate panels just because style changed.
9. Only call generate_comic_panel() when the user EXPLICITLY asks to generate or create panels.

IMPORTANT: You will receive audio from the user. Listen carefully, acknowledge briefly, then ACT (generate panels).
"""
