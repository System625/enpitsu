import asyncio
import json
import logging
import os
import re
import time

from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, RunContext, function_tool
from livekit.plugins import google, silero

from image_gen import ImageGenerator, QuotaExceededError

load_dotenv()

logger = logging.getLogger("livekit-agent")
logger.setLevel(logging.INFO)

LIVE_MODEL = "gemini-2.0-flash"

# ---------------------------------------------------------------------------
# Helper: publish JSON to frontend via LiveKit Data Channel
# ---------------------------------------------------------------------------
async def _safe_send_data(room, data: dict):
    try:
        payload = json.dumps(data).encode("utf-8")
        if room and room.local_participant:
            await room.local_participant.publish_data(payload=payload, reliable=True)
    except Exception as e:
        logger.warning(f"publish_data failed: {e}")


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------
class ComicAgent(Agent):
    def __init__(self, session_data: dict, room, image_gen: ImageGenerator, instructions: str):
        super().__init__(instructions=instructions)
        self.session_data = session_data
        self.room = room
        self.image_gen = image_gen
        self.session_page_counter = len(session_data.get("panels", []))
        self._last_imagen_time = 0.0
        self._IMAGEN_MIN_INTERVAL = 4.0

    def _build_page_prompt(self, panel_1, panel_2, panel_3, panel_4, panel_5, panel_6, style="american", safe_mode=False):
        panels = [panel_1, panel_2, panel_3, panel_4, panel_5, panel_6]

        if safe_mode:
            _strip = [
                "evacuate", "scream", "violent", "blast", "explod", "crash",
                "destroy", "chaos", "panic", "blood", "weapon", "gun", "fight",
                "attack", "kill", "dead", "dying", "death", "fire", "smoke",
            ]
            cleaned = []
            for desc in panels:
                d = desc
                for w in _strip:
                    d = re.sub(rf"\b{w}\w*\b", "react dramatically", d, flags=re.IGNORECASE)
                cleaned.append(d)
            panels = cleaned

        labels = ["wide establishing", "close-up", "action", "emotion", "action", "cliffhanger"]
        panel_lines = "\n".join(
            f"Panel {i} ({labels[i-1]}): {desc}"
            for i, desc in enumerate(panels, 1)
            if desc.strip()
        )

        rtl_styles = {"manga", "manhwa", "manhua"}
        if style in rtl_styles:
            layout_note = (
                "RIGHT-TO-LEFT reading order: panel 1 is top-RIGHT, panel 2 is top-middle, "
                "panel 3 is top-LEFT, continuing right-to-left, bottom-right to bottom-left."
            )
        else:
            layout_note = "LEFT-TO-RIGHT reading order: panel 1 is top-left, reading left to right, top to bottom."

        return (
            f"A full comic book page layout with 6 panels arranged dynamically. "
            f"{layout_note} "
            f"Clear panel borders, professional comic book artwork. "
            f"Panel descriptions:\n{panel_lines}"
        )

    # -----------------------------------------------------------------------
    # Tools
    # -----------------------------------------------------------------------

    @function_tool()
    async def generate_comic_page(
        self,
        context: RunContext,
        panel_1: str,
        panel_2: str,
        panel_3: str,
        panel_4: str,
        panel_5: str,
        panel_6: str,
        caption: str,
    ) -> str:
        """Generate a full comic book PAGE as a single image with 6 panels. Call this ONCE per page — never call it multiple times for the same page.

        Args:
            panel_1: Top-left panel — wide establishing shot. Describe characters (full appearance every time), setting, action, camera angle.
            panel_2: Top-right panel — reaction or close-up. Same character/setting details.
            panel_3: Middle-left panel — action or dialogue beat.
            panel_4: Middle-right panel — consequence or emotion beat.
            panel_5: Bottom-left panel — escalation or turn.
            panel_6: Bottom-right panel — cliffhanger or page-turn hook.
            caption: Short title for this page (max 8 words). Used as metadata only.
        """
        context.disallow_interruptions()

        self.session_page_counter += 1
        page_number = self.session_page_counter
        style = self.session_data.get("current_style", "american")

        prompt = self._build_page_prompt(panel_1, panel_2, panel_3, panel_4, panel_5, panel_6, style)

        logger.info(f"Tool: generate_comic_page | page={page_number} | caption={caption}")
        await _safe_send_data(self.room, {"type": "panel_loading", "panel_number": page_number, "caption": caption})
        await _safe_send_data(self.room, {"type": "status_update", "status": "generating", "text": f"Drawing page {page_number}..."})

        # Rate-limit Imagen calls
        elapsed = time.monotonic() - self._last_imagen_time
        if elapsed < self._IMAGEN_MIN_INTERVAL:
            await asyncio.sleep(self._IMAGEN_MIN_INTERVAL - elapsed)

        try:
            self._last_imagen_time = time.monotonic()
            image_b64 = await self.image_gen.generate_panel(prompt, style=style)

            if image_b64 is None:
                logger.warning(f"Page {page_number} safety-filtered, retrying with simplified prompt...")
                await asyncio.sleep(3)
                simplified = self._build_page_prompt(panel_1, panel_2, panel_3, panel_4, panel_5, panel_6, style, safe_mode=True)
                self._last_imagen_time = time.monotonic()
                image_b64 = await self.image_gen.generate_panel(simplified, style=style)

        except QuotaExceededError:
            await _safe_send_data(self.room, {"type": "panel_failed", "panel_number": page_number, "message": f"Page {page_number} hit the Imagen quota limit."})
            await _safe_send_data(self.room, {"type": "status_update", "status": "idle", "text": "Ready."})
            return f"Page {page_number} failed — Imagen quota exceeded (HTTP 429). Tell the user and suggest waiting before retrying."

        if image_b64:
            self.session_data.setdefault("panels", []).append({
                "panel_number": page_number, "prompt": prompt,
                "image": image_b64, "caption": caption,
                "style": style, "scene_index": self.session_data.get("current_scene_index", 0),
            })
            await _safe_send_data(self.room, {"type": "panel_generated", "image": image_b64, "prompt": prompt, "text": caption, "panel_number": page_number})
            await _safe_send_data(self.room, {"type": "status_update", "status": "idle", "text": "Ready."})
            return f"Successfully generated page {page_number}."
        else:
            await _safe_send_data(self.room, {"type": "panel_failed", "panel_number": page_number, "message": f"Page {page_number} could not be generated."})
            await _safe_send_data(self.room, {"type": "status_update", "status": "idle", "text": "Ready."})
            return f"Page {page_number} was skipped after two attempts. Continue to the next page."

    @function_tool()
    async def edit_comic_page(
        self,
        context: RunContext,
        page_number: int,
        panel_1: str,
        panel_2: str,
        panel_3: str,
        panel_4: str,
        panel_5: str,
        panel_6: str,
        caption: str,
    ) -> str:
        """Redraw an existing comic page with updated panel descriptions.

        Args:
            page_number: The 1-based page number to redraw.
            panel_1: Updated top-left panel description.
            panel_2: Updated top-right panel description.
            panel_3: Updated middle-left panel description.
            panel_4: Updated middle-right panel description.
            panel_5: Updated bottom-left panel description.
            panel_6: Updated bottom-right panel description.
            caption: Updated page caption (max 8 words).
        """
        context.disallow_interruptions()

        style = self.session_data.get("current_style", "american")
        prompt = self._build_page_prompt(panel_1, panel_2, panel_3, panel_4, panel_5, panel_6, style)

        logger.info(f"Tool: edit_comic_page | page={page_number}")
        await _safe_send_data(self.room, {"type": "status_update", "status": "generating", "text": f"Redrawing page {page_number}..."})

        elapsed = time.monotonic() - self._last_imagen_time
        if elapsed < self._IMAGEN_MIN_INTERVAL:
            await asyncio.sleep(self._IMAGEN_MIN_INTERVAL - elapsed)

        try:
            self._last_imagen_time = time.monotonic()
            image_b64 = await self.image_gen.generate_panel(prompt, style=style)
        except QuotaExceededError:
            await _safe_send_data(self.room, {"type": "status_update", "status": "idle", "text": "Ready."})
            return "Quota exceeded. Tell the user to wait before retrying."

        if image_b64:
            for p in self.session_data.get("panels", []):
                if p.get("panel_number") == page_number:
                    p["image"] = image_b64
                    p["prompt"] = prompt
                    p["caption"] = caption
            await _safe_send_data(self.room, {"type": "panel_updated", "panel_number": page_number, "image": image_b64, "text": caption, "prompt": prompt})
            await _safe_send_data(self.room, {"type": "status_update", "status": "idle", "text": "Ready."})
            return f"Successfully updated page {page_number}."
        else:
            await _safe_send_data(self.room, {"type": "status_update", "status": "idle", "text": "Ready."})
            return "Image generation failed."

    @function_tool()
    async def update_specific_line(
        self,
        context: RunContext,
        old_text: str,
        new_text: str,
    ) -> str:
        """Update a specific line or passage in the story text.

        Args:
            old_text: The exact text snippet to find and replace. Must match exactly.
            new_text: The replacement text to insert.
        """
        logger.info(f"Tool: update_specific_line | old={old_text[:60]}")
        story = self.session_data.get("story_text", "")
        if old_text and old_text in story:
            self.session_data["story_text"] = story.replace(old_text, new_text, 1)
            await _safe_send_data(self.room, {"type": "update_line", "old": old_text, "new": new_text})
            return "Successfully updated the story text."
        else:
            return "old_text not found in the story. Ensure you match the previous text exactly."

    @function_tool()
    async def set_comic_style(
        self,
        context: RunContext,
        style: str,
    ) -> str:
        """Set the art style for comic panel generation. Call this BEFORE generating any panels.

        Args:
            style: One of: 'american', 'manga', 'franco_belgian', 'manhwa', 'manhua'.
        """
        new_style = style.lower().replace(" ", "_")
        if new_style not in {"american", "manga", "franco_belgian", "manhwa", "manhua"}:
            new_style = "american"
        self.session_data["current_style"] = new_style
        logger.info(f"Tool: set_comic_style | style={new_style}")
        await _safe_send_data(self.room, {"type": "style_update", "style": new_style})
        return f"Successfully set art style to {new_style}."

    @function_tool()
    async def clear_all_panels(
        self,
        context: RunContext,
        reason: str,
    ) -> str:
        """Delete ALL existing panels to start fresh.

        Args:
            reason: Brief reason for clearing (e.g. 'user wants different style').
        """
        logger.info(f"Tool: clear_all_panels | reason={reason}")
        count = len(self.session_data.get("panels", []))
        self.session_data["panels"] = []
        self.session_page_counter = 0
        await _safe_send_data(self.room, {"type": "panels_cleared"})
        await _safe_send_data(self.room, {"type": "status_update", "status": "idle", "text": f"Cleared {count} pages."})
        return f"Successfully cleared {count} panels."

    @function_tool()
    async def play_music_during_wait(
        self,
        context: RunContext,
        music_type: str,
    ) -> str:
        """Play background music while panels are being generated. Call this BEFORE generating panels.

        Args:
            music_type: Type of ambient music: 'epic', 'calm', 'suspense', 'happy', or 'sad'.
        """
        logger.info(f"Tool: play_music_during_wait | type={music_type}")
        await _safe_send_data(self.room, {"type": "play_music", "music_type": music_type})
        return f"Successfully started playing {music_type} background music."


# ---------------------------------------------------------------------------
# System prompt builder
# ---------------------------------------------------------------------------
def _build_system_instruction(story_text: str) -> str:
    story_section = (
        f"STORY TEXT:\n{story_text}"
        if story_text.strip()
        else "STORY TEXT:\n(No story uploaded yet. Help the user describe their story idea or ask them to upload a PDF/DOCX file.)"
    )

    return f"""You are Enpitsu, a professional Comic Book Creative Director and AI Co-Creator.
You help users turn their stories into stunning comic books through real-time voice conversation.

{story_section}

HOW YOU COMMUNICATE:
- You are a LISTENER first. Always let the user finish speaking before you respond.
- Speak in short, natural sentences — like a friend, not a robot.
- ALWAYS acknowledge what the user just said before moving on: "Love that!", "Great idea!", "Got it, so you want..."
- If anything is unclear, ASK a short clarifying question and WAIT for the answer. Do NOT guess.
- After you act, invite feedback: "How does that look?" or "Want me to change anything?"
- Keep your spoken responses to 2-3 sentences max unless the user asks for more detail.

VISUAL CONSISTENCY — THIS IS CRITICAL:
Before generating ANY page, mentally define a CHARACTER REFERENCE for each character:
- Name, age, body type, hair (color, length, style), skin tone, eye color
- Outfit: exact clothing, colors, accessories
- Distinguishing features: scars, glasses, tattoos, etc.
REPEAT these exact details in EVERY panel field.

Every panel field MUST include:
1. Full character appearance (EVERY panel, even if repeated)
2. Setting/background details
3. Action/pose
4. Camera angle (wide shot, close-up, mid-shot, etc.)
Do NOT include speech bubble text in panel descriptions.

CRITICAL — TOOL CALL ORDERING:
1. Call set_comic_style if needed — no speech yet
2. Call play_music_during_wait — no speech yet
3. Call generate_comic_page — no speech yet
4. THEN speak ONE brief sentence: "Drawing it now!" or "Page 1 is on its way!"

ABSOLUTE RULE — NEVER READ PANEL DESCRIPTIONS OUT LOUD.
When you call generate_comic_page() or edit_comic_page(), do NOT verbally describe the panels. The user will SEE the image.

WHEN TO GENERATE A PAGE:
- ONLY when the user gives a clear instruction: "generate", "start", "make the first page", "draw it", etc.
- Call generate_comic_page() EXACTLY ONCE per page.
"""


# ---------------------------------------------------------------------------
# Server entrypoint
# ---------------------------------------------------------------------------
server = AgentServer()


@server.rtc_session(agent_name="enpitsu")
async def entrypoint(ctx: JobContext):
    metadata = ctx.room.metadata
    session_data = {}
    if metadata:
        try:
            session_data = json.loads(metadata)
        except Exception as e:
            logger.warning(f"Could not parse room metadata: {e}")

    story_text = session_data.get("story_text", "")
    instructions = _build_system_instruction(story_text)

    image_gen = ImageGenerator()
    agent = ComicAgent(session_data, ctx.room, image_gen, instructions)

    session = AgentSession(
        stt=google.STT(),
        llm=google.LLM(model=LIVE_MODEL),
        tts=google.TTS(),
        vad=silero.VAD.load(),
    )

    await session.start(room=ctx.room, agent=agent)

    await session.generate_reply(
        instructions="Greet the user warmly as Enpitsu, the comic book AI co-creator. Ask if they're ready to start drawing their comic."
    )


if __name__ == "__main__":
    agents.cli.run_app(server)
