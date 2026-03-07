import io
import logging

from docx import Document
from pypdf import PdfReader

logger = logging.getLogger(__name__)


class StoryProcessor:
    @staticmethod
    async def extract_text(file_content: bytes, filename: str) -> str:
        """Extracts plain text from a PDF or DOCX file."""
        ext = filename.lower().split(".")[-1]
        text = ""

        try:
            if ext == "pdf":
                reader = PdfReader(io.BytesIO(file_content))
                text = "\n".join(page.extract_text() for page in reader.pages if page.extract_text())
            elif ext == "docx":
                doc = Document(io.BytesIO(file_content))
                text = "\n".join(para.text for para in doc.paragraphs if para.text.strip())
            else:
                logger.warning(f"Unsupported file extension: {ext}")
                return ""

            return text.strip()

        except Exception as e:
            logger.error(f"Error extracting text from {filename}: {e}")
            return ""

    @staticmethod
    def break_into_scenes(text: str) -> list[str]:
        """
        Breaks story text into scenes.

        Strategy (in order of preference):
        1. Split on common chapter/scene headings (Chapter, Scene, Act, Part, INT., EXT.)
        2. Fall back to paragraph breaks (double newlines)
        3. If still only one chunk, split into ~500-word segments so the agent
           has granular context to work with.
        """
        import re

        # Try heading-based split
        heading_pattern = re.compile(
            r"(?m)^(?:chapter|scene|act|part|int\.|ext\.)\s+\S.*$",
            re.IGNORECASE,
        )
        if heading_pattern.search(text):
            parts = heading_pattern.split(text)
            headings = heading_pattern.findall(text)
            scenes = []
            for i, part in enumerate(parts):
                heading = headings[i - 1] if i > 0 else ""
                chunk = (heading + "\n" + part).strip() if heading else part.strip()
                if chunk:
                    scenes.append(chunk)
            if len(scenes) > 1:
                return scenes

        # Fall back to paragraph breaks
        scenes = [s.strip() for s in text.split("\n\n") if s.strip()]
        if len(scenes) > 1:
            return scenes

        # Last resort: fixed word-count segments (~500 words each)
        words = text.split()
        chunk_size = 500
        scenes = [" ".join(words[i : i + chunk_size]) for i in range(0, len(words), chunk_size)]
        return [s for s in scenes if s]
