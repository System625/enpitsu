import asyncio
import logging
import os
from typing import Callable

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# Vertex AI Live API model (confirmed working with ADC)
LIVE_MODEL = "gemini-2.0-flash-live-preview-04-09"

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
                                "action, lighting, composition, camera angle."
                            ),
                        ),
                        "caption": types.Schema(
                            type=types.Type.STRING,
                            description=(
                                "The comic book speech bubble text, internal monologue, or dramatic "
                                "narration for this panel. Max 12 words. Authentic comic voice."
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
    def __init__(self, model_id: str = LIVE_MODEL):
        self.model_id = model_id
        self.client = make_client()
        self.session = None
        self._ready = asyncio.Event()
        self._stop = False

    async def connect(self, system_instruction: str, on_message: Callable):
        """
        Opens a Gemini Multimodal Live API session and streams all
        incoming messages to the on_message callback.
        Automatically reconnects when the session ends after a turn.
        """
        config = types.LiveConnectConfig(
            system_instruction=system_instruction,
            response_modalities=["AUDIO"],  # type: ignore[arg-type]
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede"))
            ),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            tools=COMIC_TOOLS,
        )

        self._stop = False

        while not self._stop:
            try:
                async with self.client.aio.live.connect(model=self.model_id, config=config) as session:
                    self.session = session
                    self._ready.set()
                    logger.info(f"Connected to Gemini Live API: {self.model_id}")

                    async for message in session.receive():
                        await on_message(message)

                    logger.info("Gemini session ended (turn complete). Reconnecting...")

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Gemini Live session error: {e}")
                break
            finally:
                self.session = None
                self._ready.clear()

    async def send_text(self, text: str):
        """Sends a text turn to the agent. Waits until the session is ready."""
        await asyncio.wait_for(self._ready.wait(), timeout=15)
        if self.session:
            await self.session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part(text=text)]),
                turn_complete=True,
            )

    async def send_audio(self, audio_data: bytes):
        """
        Sends a raw PCM audio chunk to the agent.
        Expected format: 16-bit signed PCM, 16kHz, mono.
        """
        await asyncio.wait_for(self._ready.wait(), timeout=15)
        if self.session:
            logger.debug(f"Sending audio chunk: {len(audio_data)} bytes")
            await self.session.send_realtime_input(audio=types.Blob(data=audio_data, mime_type="audio/pcm;rate=16000"))

    async def send_audio_end(self):
        """
        Signals end of user's audio turn so Gemini knows to start responding.
        Uses ActivityEnd for explicit VAD signalling.
        """
        await asyncio.wait_for(self._ready.wait(), timeout=15)
        if self.session:
            logger.info("Sending ActivityEnd to Gemini (audio turn complete)")
            await self.session.send_realtime_input(activity_end=types.ActivityEnd())

    async def send_tool_response(self, function_call_id: str, function_name: str, response: dict):
        """Sends a tool function response back to Gemini after executing a tool call."""
        await asyncio.wait_for(self._ready.wait(), timeout=15)
        if self.session:
            await self.session.send_tool_response(
                function_responses=[
                    types.FunctionResponse(
                        id=function_call_id,
                        name=function_name,
                        response=response,
                    )
                ]
            )

    def get_system_instruction(self, story_text: str) -> str:
        """Constructs the Creative Director system prompt with the story injected."""
        return f"""You are Enpitsu, a professional Comic Book Creative Director and AI Co-Creator.
Your goal is to help the user turn their story into a stunning comic book through real-time collaboration.

STORY TEXT:
{story_text}

YOUR RESPONSIBILITIES:
1. Act as a warm, creative collaborator. Use a friendly, professional tone.
2. Read the story and propose panel layouts (e.g., "For this scene, I suggest a wide cinematic panel showing the hero's arrival").
3. Respond to the user's voice and text input in real-time.
4. When you want to render a panel, call the generate_comic_panel() tool with a visual description and caption.
5. When the user asks to change or edit an existing panel, call the edit_existing_panel() tool.
6. Keep responses focused and concise — the user is in a live creative session.
7. Do not ask for permission before generating panels — pick sensible creative defaults and generate immediately.
8. If the user asks for multiple panels or to illustrate the whole story, call generate_comic_panel() multiple times in one response.

IMPORTANT: You will receive audio from the user. Listen carefully, acknowledge their input, and respond conversationally.
"""
