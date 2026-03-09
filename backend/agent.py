import asyncio
import logging
import os
from typing import Callable, Optional

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# Gemini Live API model (confirmed working on Vertex AI)
# Note: gemini-2.5-flash-native-audio-preview-12-2025 is AI Studio only, not Vertex AI
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
                                "Detailed visual description of the panel. MUST include: "
                                "1) Full character appearance every time (hair color/style, skin tone, "
                                "clothing with colors, body type — repeat for EVERY panel). "
                                "2) Setting/background details (same across all panels in a scene). "
                                "3) Action/pose. 4) Camera angle. 5) Lighting. "
                                "Include speech bubbles if needed. Be specific and consistent."
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
            types.FunctionDeclaration(
                name="update_specific_line",
                description=(
                    "Update a specific line or passage in the story text. "
                    "Use when the user asks to change dialogue, fix a typo, "
                    "rewrite a sentence, or tweak any part of the story."
                ),
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "old_text": types.Schema(
                            type=types.Type.STRING,
                            description=(
                                "The exact text snippet to find and replace. Must match the current story text exactly."
                            ),
                        ),
                        "new_text": types.Schema(
                            type=types.Type.STRING,
                            description="The replacement text to insert.",
                        ),
                    },
                    required=["old_text", "new_text"],
                ),
            ),
            types.FunctionDeclaration(
                name="play_music_during_wait",
                description=(
                    "Play background music while panels are being generated. "
                    "Call this BEFORE generating panels to set the mood."
                ),
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "music_type": types.Schema(
                            type=types.Type.STRING,
                            description=(
                                "Type of ambient music: 'epic' for action scenes, "
                                "'calm' for peaceful scenes, 'suspense' for tension, "
                                "'happy' for cheerful moments, 'sad' for emotional scenes."
                            ),
                        ),
                    },
                    required=["music_type"],
                ),
            ),
            types.FunctionDeclaration(
                name="clear_all_panels",
                description=(
                    "Delete ALL existing panels so you can start fresh. "
                    "Use when the user doesn't like the current panels and wants to redo them, "
                    "or says things like 'start over', 'redo all panels', 'clear everything', "
                    "'I don't like these', 'try again from scratch'."
                ),
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "reason": types.Schema(
                            type=types.Type.STRING,
                            description="Brief reason for clearing (e.g. 'user wants different style').",
                        ),
                    },
                    required=["reason"],
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
                voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede"))
            ),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=False,
                    # LOW = less eager to declare "user started talking"
                    start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_LOW,
                    # LOW = waits longer before declaring "user stopped talking"
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                    # Wait 500ms of confirmed speech before committing start-of-speech
                    prefix_padding_ms=500,
                    # Wait 2000ms of silence before ending the user's turn —
                    # gives the user time to pause mid-sentence without being cut off
                    silence_duration_ms=2000,
                ),
            ),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
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
                """Receive all Gemini events and forward to on_message.
                Re-enters session.receive() after each turn_complete so the
                session stays alive across multiple turns.
                """
                try:
                    while not self._stop:
                        async for message in session.receive():
                            if self._stop:
                                break
                            await on_message(message)
                        # session.receive() exhausted after turn_complete — loop back
                        # to wait for the next turn without closing the session
                        if self._stop:
                            break
                        logger.debug("Receive loop: turn complete, waiting for next turn...")
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

    async def wait_until_ready(self, timeout: float = 15.0):
        """Wait until the Gemini Live session is open and ready to receive input."""
        await asyncio.wait_for(self._session_ready.wait(), timeout=timeout)

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
        """Send a single tool function response back to the active session."""
        await self.send_tool_responses_batch([(function_call_id, function_name, response)])

    async def send_tool_responses_batch(self, responses: list[tuple[str, str, dict]]):
        """
        Send multiple tool function responses in a single call.
        Gemini Live expects all responses for a tool_call batch to arrive together.
        responses: list of (function_call_id, function_name, response_dict)
        """
        if self._session and self._session_ready.is_set():
            try:
                await self._session.send_tool_response(  # type: ignore[attr-defined]
                    function_responses=[
                        types.FunctionResponse(
                            id=call_id,
                            name=name,
                            response=resp,
                        )
                        for call_id, name, resp in responses
                    ]
                )
            except Exception as e:
                logger.error(f"send_tool_response error: {e}")
        else:
            logger.warning("Cannot send tool response — session not active")

    def get_system_instruction(self, story_text: str) -> str:
        """Constructs the Creative Director system prompt with the story injected."""
        return f"""You are Enpitsu, a professional Comic Book Creative Director and AI Co-Creator.
You help users turn their stories into stunning comic books through real-time voice conversation.

STORY TEXT:
{story_text}

HOW YOU COMMUNICATE:
- You are a LISTENER first. Always let the user finish speaking before you respond.
- Speak in short, natural sentences — like a friend, not a robot.
- ALWAYS acknowledge what the user just said before moving on: "Love that!", "Great idea!", "Got it, so you want..."
- If anything is unclear, ASK a short clarifying question and WAIT for the answer. Do NOT guess.
- After you act, invite feedback: "How does that look?" or "Want me to change anything?"
- Keep your spoken responses to 2-3 sentences max unless the user asks for more detail.
- You're having a real conversation. Never rush. Never talk over the user.

CONVERSATION FLOW — follow this order:
1. LISTEN to the user's full message
2. ACKNOWLEDGE what they said (reference their words)
3. DECIDE: Do you need to clarify anything? If yes → ASK and WAIT. If no → proceed
4. ACT: generate panels, edit panels, or discuss

VISUAL CONSISTENCY — THIS IS CRITICAL:
Before generating ANY panels, mentally define a CHARACTER REFERENCE for each character:
- Name, age, body type, hair (color, length, style), skin tone, eye color
- Outfit: exact clothing, colors, accessories
- Distinguishing features: scars, glasses, tattoos, etc.

Then REPEAT these exact details in EVERY panel's visual_description. For example:
- GOOD: "Tate, a 16-year-old lean boy with short curly black hair, brown skin, wearing a blue #10 soccer jersey and white shorts, kicks the ball"
- BAD: "A boy kicks the ball" (too vague — will look like a different character each time)

ALSO keep the SETTING consistent:
- Same location details across panels (e.g., "green soccer field with red bleachers in background")
- Same time of day / lighting (e.g., "afternoon sunlight, warm golden tones")
- Same sport, same activity — do NOT switch sports or settings mid-scene

Every visual_description MUST include:
1. Full character appearance description (EVERY time, even if repeated)
2. Setting/background details
3. The specific action or pose
4. Camera angle (wide shot, close-up, mid-shot, etc.)

WHEN TO GENERATE PANELS:
- ONLY generate panels when the user gives a clear, explicit instruction like "generate", "start", "make panels", "create the first page", "illustrate this scene", "draw it"
- Before generating, briefly confirm what you'll create: "Alright, I'll draw 6 panels for the opening scene with..."
- CRITICAL: Call generate_comic_panel() EXACTLY 6 times in a SINGLE response. Do NOT call it once, wait for a response, then call it again. ALL 6 calls must be in ONE tool_call batch.
- Do NOT speak or ask questions between panel generations. Generate all 6, THEN speak.
- Vary compositions across the 6 panels:
  • Panel 1: Wide establishing shot
  • Panels 2-4: Mid-shots, close-ups, dialogue beats
  • Panels 5-6: Action or cliffhanger
- Include speech bubbles in the visual_description (e.g., "speech bubble saying 'Run!'")
- The caption field is short metadata only (max 12 words)
- NEVER change the sport, activity, or character appearance between panels in the same scene
- After ALL 6 panels are generated, THEN ask the user what they think

WHEN NOT TO GENERATE PANELS:
- When the user is just chatting, asking questions, or discussing the story
- When the user changes art style — just acknowledge it in one sentence
- When you're unsure what the user wants — ask first

STORY TEXT EDITING:
- When the user wants to change dialogue, fix wording, or rewrite part of the story, use update_specific_line().
- The old_text must be an EXACT match of what's currently in the story.
- After updating, briefly confirm what you changed.

BACKGROUND MUSIC:
- Before generating panels, call play_music_during_wait() to set the mood.
- Pick the music_type that matches the scene: 'epic', 'calm', 'suspense', 'happy', or 'sad'.
- Call it ONCE before the batch of generate_comic_panel() calls — not between panels.

EDITING & REDOING PANELS:
- To change ONE panel: use edit_existing_panel() with the panel number
  Example: user says "change panel 3" or "make panel 2 darker"
- To redo ALL panels: first call clear_all_panels(), then generate new ones with generate_comic_panel()
  Example: user says "I don't like these", "start over", "redo everything", "try again"
- When the user expresses dissatisfaction with the panels, ASK if they want to edit specific panels or redo all of them
- After clearing, immediately generate new panels based on the user's feedback

IMPORTANT: This is a CONVERSATION. The user wants to collaborate with you, not just give you orders. Be curious about their vision. Ask about their characters, their favorite scenes, what mood they want. Make them feel heard.
"""
