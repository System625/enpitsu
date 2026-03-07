import asyncio
import logging
import base64
from typing import Optional
from google.genai import types

from agent import make_client

logger = logging.getLogger(__name__)


class ImageGenerator:
    def __init__(self, model_id: str = "imagen-4.0-generate-001"):
        # On Vertex Express, use "imagen-4.0-generate-001" or "imagen-4.0-fast-generate-001"
        self.model_id = model_id
        self.client = make_client()

    # Maps frontend style keys to Imagen-optimised prompt descriptors
    STYLE_PROMPTS = {
        "american":      "American superhero comic book style, bold dynamic lines, vibrant colors, Marvel/DC aesthetic",
        "manga":         "Japanese manga style, black and white ink, screentone shading, expressive characters",
        "franco_belgian":"Franco-Belgian bande dessinée style, ligne claire, Tintin/Asterix aesthetic, clean outlines",
        "manhwa":        "Korean manhwa webtoon style, high quality digital painting, full color, cinematic lighting",
        "manhua":        "Chinese manhua style, wuxia fantasy, intricate ink details, dramatic compositions",
    }

    async def generate_panel(self, prompt: str, style: str = "american") -> Optional[str]:
        """
        Generates a comic panel image from a prompt and art style.
        Returns the image as a base64-encoded JPEG string, or None on failure.

        Runs the synchronous Imagen SDK call in a thread executor so it
        doesn't block the FastAPI event loop.
        """
        style_key = style.lower().replace(" ", "_")
        style_descriptor = self.STYLE_PROMPTS.get(style_key, self.STYLE_PROMPTS["american"])
        enhanced_prompt = (
            f"Comic book panel, {style_descriptor}, {prompt}. "
            "High quality, detailed, professional artwork."
        )
        logger.info(f"Generating panel | style={style} | prompt={enhanced_prompt}")

        try:
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.client.models.generate_images(
                    model=self.model_id,
                    prompt=enhanced_prompt,
                    config=types.GenerateImagesConfig(
                        number_of_images=1,
                        output_mime_type="image/jpeg",
                        aspect_ratio="4:3",
                    ),
                ),
            )

            if response.generated_images:
                image_bytes = response.generated_images[0].image.image_bytes
                return base64.b64encode(image_bytes).decode("utf-8")

            logger.warning("Imagen returned no images.")
            return None

        except Exception as e:
            logger.error(f"Image generation failed: {e}")
            return None
