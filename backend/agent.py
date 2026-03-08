import asyncio
import logging
import os
from typing import Callable, Optional, cast

from google import genai
from google.genai import live, types

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
    Manages a Gemini Live API session that reconnects on-demand when the user
    sends new input. Does NOT auto-reconnect after turn_complete to avoid
    history replay triggering duplicate tool calls.
    """

    def __init__(self, model_id: str = LIVE_MODEL):
        self.model_id = model_id
        self.client = make_client()
        self.session: Optional[live.AsyncSession] = None
        self._ready = asyncio.Event()
        self._stop = False
        self._connect_lock = asyncio.Lock()
        # Conversation history for context replay on reconnect
        self._history: list[types.Content] = []
        self._config: Optional[types.LiveConnectConfig] = None
        self._on_message: Optional[Callable] = None
        self._session_task: Optional[asyncio.Task] = None

    async def connect(self, system_instruction: str, on_message: Callable):
        """
        Opens the first Gemini Live API session. Subsequent sessions are
        started on-demand by _ensure_session() when the user sends input.
        """
        self._config = types.LiveConnectConfig(
            system_instruction=system_instruction,
            response_modalities=["AUDIO"],  # type: ignore[arg-type]
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede"))
            ),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            tools=COMIC_TOOLS,
        )
        self._on_message = on_message
        self._stop = False

        # Start the first session and wait for it to be ready
        await self._run_session()

    async def _run_session(self):
        """Run a single Gemini Live session until it naturally ends."""
        try:
            async with self.client.aio.live.connect(model=self.model_id, config=self._config) as session:
                self.session = session
                self._ready.set()
                logger.info(f"Connected to Gemini Live API: {self.model_id}")

                # Replay conversation history on reconnect so Gemini has context
                if self._history:
                    logger.info(f"Replaying {len(self._history)} history turns")
                    await session.send_client_content(
                        turns=cast(list[types.Content | types.ContentDict], self._history),
                        turn_complete=True,
                    )

                async for message in session.receive():
                    if self._stop:
                        break
                    if self._on_message is not None:
                        await self._on_message(message)

                # Session ended naturally (turn_complete). Do NOT auto-reconnect.
                # _ensure_session() will reconnect when the user sends new input.
                logger.info("Gemini session ended (turn complete). Idle until next user input.")

        except asyncio.CancelledError:
            raise
        except Exception as e:
            if not self._stop:
                logger.error(f"Gemini Live session error: {e}")
        finally:
            self.session = None
            self._ready.clear()

    async def _ensure_session(self):
        """Reconnect if the session has ended. Called before sending user input."""
        if self._stop:
            return
        if self.session is not None and self._ready.is_set():
            return  # Session is alive

        async with self._connect_lock:
            # Double-check after acquiring lock
            if self.session is not None and self._ready.is_set():
                return

            logger.info("Reconnecting Gemini session for new user input...")
            self._session_task = asyncio.create_task(self._run_session())
            try:
                await asyncio.wait_for(self._ready.wait(), timeout=15)
            except asyncio.TimeoutError:
                logger.error("Timed out waiting for Gemini session to connect")

    def _add_to_history(self, role: str, text: str):
        """Append a text turn to conversation history (keeps last 20 turns to avoid token limits)."""
        self._history.append(types.Content(role=role, parts=[types.Part(text=text)]))
        if len(self._history) > 20:
            self._history = self._history[-20:]

    async def send_text(self, text: str):
        """Sends a text turn to the agent. Reconnects if session has ended."""
        await self._ensure_session()
        if self.session:
            self._add_to_history("user", text)
            await self.session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part(text=text)]),
                turn_complete=True,
            )

    def record_agent_response(self, text: str):
        """Record an agent transcription into history so it's replayed on reconnect."""
        self._add_to_history("model", text)

    async def send_audio(self, audio_data: bytes):
        """
        Sends a raw PCM audio chunk to the agent.
        Expected format: 16-bit signed PCM, 16kHz, mono.
        Non-blocking — silently drops if session is not ready.
        """
        if not self._ready.is_set() or self.session is None:
            return
        try:
            await self.session.send_realtime_input(audio=types.Blob(data=audio_data, mime_type="audio/pcm;rate=16000"))
        except Exception:
            pass

    async def send_audio_end(self):
        """
        Signals end of user's audio turn so Gemini knows to start responding.
        Reconnects if needed so the audio turn isn't lost.
        """
        await self._ensure_session()
        if self.session:
            logger.info("Sending ActivityEnd to Gemini (audio turn complete)")
            await self.session.send_realtime_input(activity_end=types.ActivityEnd())

    async def send_tool_response(self, function_call_id: str, function_name: str, response: dict):
        """Sends a tool function response back to Gemini after executing a tool call."""
        # Tool responses go to the current session — don't reconnect for these
        if not self._ready.is_set() or self.session is None:
            logger.warning("Cannot send tool response — session not active")
            return
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
2. Respond to the user's voice and text input in real-time. Follow their creative direction.
3. When the user asks you to generate panels (or says things like "start", "give me the first panel", "illustrate this"), IMMEDIATELY call the generate_comic_panel() tool. Do NOT keep asking clarifying questions — just pick great creative defaults and generate.
4. Include speech bubbles and dialogue directly in the visual_description so they are rendered INTO the image (e.g., "speech bubble saying 'Run!'"). The caption field is just a short metadata summary.
5. When the user asks to change or edit an existing panel, call the edit_existing_panel() tool.
6. Keep responses SHORT and action-oriented. This is a live creative session — bias toward generating panels, not talking about generating panels.
7. If the user asks for multiple panels or to illustrate the whole story, call generate_comic_panel() multiple times in sequence.
8. If the user's request is vague (e.g., "make it"), use your creative judgment and just generate something good.
9. When the user changes the art style, acknowledge it briefly (1 sentence max) and continue. Do NOT generate a new panel just because the style changed.
10. Only call generate_comic_panel() when the user EXPLICITLY asks you to generate or create a panel. Never generate panels on your own initiative after a reconnection or context replay.

IMPORTANT: You will receive audio from the user. Listen carefully, acknowledge briefly, then ACT (generate panels). Do not repeatedly ask what the user wants — if they say "generate", GENERATE.
"""
