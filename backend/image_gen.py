import asyncio
import base64
import logging
import os
from typing import Optional

# genai package currently lacks proper type stubs; suppress mypy/pyright complaints
from google import genai  # type: ignore[reportMissingImports,reportUnknownVariableType]
from google.genai import types  # type: ignore[reportMissingImports]

logger = logging.getLogger(__name__)


class QuotaExceededError(Exception):
    """Raised when Imagen API returns a quota/rate-limit error."""


class ImageGenerator:
    def __init__(self, model_id: str = "imagen-4.0-generate-001"):
        # On Vertex Express, use "imagen-4.0-generate-001" or "imagen-4.0-fast-generate-001"
        self.model_id = model_id

        # Initialize Google GenAI client based on environment variables
        api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("VERTEX_EXPRESS_API_KEY")
        if api_key:
            self.client = genai.Client(api_key=api_key)
        else:
            # Fallback to default ADC (Application Default Credentials)
            self.client = genai.Client()

    # Maps frontend style keys to Imagen-optimised prompt descriptors.
    # NOTE: No speech bubble TEXT — Imagen cannot reliably render readable text.
    # Bubbles appear visually but are left blank; text is handled in the UI layer.
    STYLE_PROMPTS = {
        "american": (
            "American superhero comic book style, bold dynamic lines, vibrant colors, Marvel/DC aesthetic, "
            "purely visual storytelling with no text or lettering anywhere"
        ),
        "manga": (
            "WORDLESS manga page, zero text anywhere, zero Japanese characters, "
            "Japanese manga style, black and white ink, screentone shading, expressive characters, "
            "purely visual silent storytelling, absolutely no hiragana no katakana no kanji "
            "no onomatopoeia no sound effects no written characters of any kind"
        ),
        "franco_belgian": (
            "Franco-Belgian bande dessinée style, ligne claire, Tintin/Asterix aesthetic, clean outlines, "
            "purely visual storytelling with no text or lettering anywhere"
        ),
        "manhwa": (
            "Korean manhwa webtoon style, high quality digital painting, full color, cinematic lighting, "
            "purely visual storytelling with absolutely no text, no hangul, no Korean characters anywhere"
        ),
        "manhua": (
            "Chinese manhua style, wuxia fantasy, intricate ink details, dramatic compositions, "
            "purely visual storytelling with absolutely no text, no hanzi, no Chinese characters anywhere"
        ),
    }

    # Style-specific text suppression added to the end of every prompt.
    _NO_TEXT_SUFFIX = {
        "manga": (
            "STRICT REQUIREMENT: zero Japanese text, zero hiragana, zero katakana, zero kanji, "
            "zero sound-effect glyphs, zero onomatopoeia characters anywhere. "
            "All speech bubbles completely empty."
        ),
        "manhwa": (
            "STRICT REQUIREMENT: zero Korean hangul characters, zero Korean text, "
            "zero sound-effect glyphs anywhere. All speech bubbles completely empty."
        ),
        "manhua": (
            "STRICT REQUIREMENT: zero Chinese hanzi characters, zero Chinese text, "
            "zero calligraphy glyphs anywhere. All speech bubbles completely empty."
        ),
    }
    _DEFAULT_NO_TEXT = (
        "STRICT REQUIREMENT: zero letters, zero numbers, zero words, zero symbols that resemble writing "
        "of any language anywhere in the image. All speech bubbles completely empty."
    )

    def _build_prompt(self, prompt: str, style: str) -> str:
        style_key = style.lower().replace(" ", "_")
        style_descriptor = self.STYLE_PROMPTS.get(style_key, self.STYLE_PROMPTS["american"])
        no_text = self._NO_TEXT_SUFFIX.get(style_key, self._DEFAULT_NO_TEXT)
        return (
            f"Comic book panel, {style_descriptor}, {prompt}. "
            f"NO text, letters, numbers, or written characters of any language anywhere in the image. "
            f"{no_text} "
            f"High quality, detailed, professional artwork."
        )

    async def _call_imagen(
        self,
        prompts: list[str],
        max_retries: int = 3,
        retry_delay: float = 10.0,
    ) -> list[Optional[str]]:
        """
        Single Imagen API call for 1–4 prompts (number_of_images = len(prompts)).
        Returns a list of base64 JPEG strings (or None for filtered/failed slots).
        Retries with exponential backoff on quota (429) errors.

        NOTE: Imagen generates number_of_images images all from the SAME prompt.
        For per-panel prompts we call once per panel but batch groups of up to 4
        so that each panel gets its own unique prompt while minimising API calls.
        """
        # Imagen's number_of_images applies the same prompt N times — it cannot
        # accept different prompts in one call. So we still call once per panel,
        # but we keep the retry/backoff logic centralised here.
        assert len(prompts) == 1, "Call _call_imagen with one prompt at a time."
        prompt = prompts[0]
        loop = asyncio.get_event_loop()

        for attempt in range(1, max_retries + 1):
            try:
                response = await loop.run_in_executor(
                    None,
                    lambda: self.client.models.generate_images(
                        model=self.model_id,
                        prompt=prompt,
                        config=types.GenerateImagesConfig(
                            number_of_images=1,
                            output_mime_type="image/jpeg",
                            aspect_ratio="4:3",
                            safety_filter_level=types.SafetyFilterLevel.BLOCK_ONLY_HIGH,
                            person_generation=types.PersonGeneration.ALLOW_ALL,
                        ),
                    ),
                )
                if response.generated_images:
                    img = response.generated_images[0].image
                    if img is None or img.image_bytes is None:
                        logger.warning("Imagen returned image with no bytes — likely safety-filtered.")
                        return [None]
                    return [base64.b64encode(img.image_bytes).decode("utf-8")]

                filtered_reason = getattr(response, "filtered_reason", None)
                if filtered_reason:
                    logger.warning(f"Imagen filtered: {filtered_reason}")
                logger.warning(f"Imagen returned no images for prompt: {prompt[:120]}")
                return [None]

            except Exception as e:
                msg = str(e)
                if "429" in msg or "RESOURCE_EXHAUSTED" in msg or "quota" in msg.lower():
                    if attempt < max_retries:
                        wait = retry_delay * (1.5 ** (attempt - 1))  # 10s → 15s → 22.5s
                        logger.warning(
                            f"Imagen quota hit (attempt {attempt}/{max_retries}), retrying in {wait:.0f}s..."
                        )
                        await asyncio.sleep(wait)
                        continue
                    logger.error(f"Imagen quota exhausted after {max_retries} attempts: {e}")
                    raise QuotaExceededError(msg) from e
                logger.error(f"Image generation failed: {e}")
                return [None]

        return [None]

    async def generate_panel(self, prompt: str, style: str = "american") -> Optional[str]:
        """Generate a single comic panel. Returns base64 JPEG or None."""
        enhanced = self._build_prompt(prompt, style)
        logger.info(f"Generating panel | style={style} | prompt={enhanced}")
        results = await self._call_imagen([enhanced])
        return results[0]
