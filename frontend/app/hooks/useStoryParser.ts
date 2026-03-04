import { ComicStyle } from "./useLiveAgent";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface StoryCharacter {
  name: string;
  aliases: string[];
  gender: "male" | "female" | "unknown";
  description: string; // visual descriptors found in text
}

export interface StoryScene {
  pageNumber: number;
  narrative: string;
  setting: string;
  characters: string[];
  action: string;
  dialogue: string[]; // quoted lines
  mood: string;
}

export interface ParsedStory {
  title: string;
  characters: StoryCharacter[];
  scenes: StoryScene[];
  fullText: string;
}

/* ------------------------------------------------------------------ */
/*  Text extraction via API                                            */
/* ------------------------------------------------------------------ */

export async function extractTextFromFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();

  // Plain text: read directly
  if (name.endsWith(".txt")) {
    return file.text();
  }

  // PDF / other: send to server route
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/parse-story", { method: "POST", body: form });
  if (!res.ok) throw new Error("Failed to extract text");
  const json = await res.json();
  return json.text as string;
}

/* ------------------------------------------------------------------ */
/*  Character extraction                                               */
/* ------------------------------------------------------------------ */

// Gendered pronoun clusters within ±80 chars of a name mention
const FEMALE_SIGNALS = /\b(she|her|hersel[f]|woman|girl|lady|female|detective\s+\w+\s+(?:she|her))\b/i;
const MALE_SIGNALS = /\b(he|his|him|himself|man|boy|guy|male)\b/i;

function extractCharacters(text: string): StoryCharacter[] {
  // Find capitalized multi-word proper nouns (first + last or "The Something")
  const namePattern = /(?:(?:The|Detective|Professor|Doctor|Dr\.|Mr\.|Mrs\.|Ms\.)\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g;
  const nameCounts = new Map<string, number>();
  let m: RegExpExecArray | null;

  // Common false-positive words to skip
  const stopWords = new Set([
    "The", "She", "Her", "He", "His", "They", "But", "And", "Not", "Now",
    "Every", "Another", "Behind", "Welcome", "Those", "From", "Deep",
    "Slow", "Silence", "Above", "Nothing", "Comedy", "No", "Page",
    "Because", "Underneath",
  ]);

  while ((m = namePattern.exec(text)) !== null) {
    const name = m[0].trim();
    if (name.length < 3 || stopWords.has(name)) continue;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  // Keep names that appear 2+ times (or prefixed with Detective/The/etc.)
  const significantNames: string[] = [];
  for (const [name, count] of nameCounts) {
    if (count >= 2 || /^(The|Detective|Professor|Doctor|Dr\.|Mr\.|Mrs\.|Ms\.)\s/.test(name)) {
      significantNames.push(name);
    }
  }

  // Deduplicate: "Mira Voss" and "Mira" → keep "Mira Voss", alias "Mira"
  const characters: StoryCharacter[] = [];
  const consumed = new Set<string>();

  // Sort longest first so "Mira Voss" beats "Mira"
  significantNames.sort((a, b) => b.length - a.length);

  for (const name of significantNames) {
    if (consumed.has(name)) continue;

    const aliases: string[] = [];
    // Check if shorter names are substrings of this one
    for (const other of significantNames) {
      if (other !== name && name.includes(other) && !consumed.has(other)) {
        aliases.push(other);
        consumed.add(other);
      }
    }
    consumed.add(name);

    // Detect gender from surrounding context
    let gender: "male" | "female" | "unknown" = "unknown";
    const allNames = [name, ...aliases];
    for (const n of allNames) {
      const idx = text.indexOf(n);
      if (idx === -1) continue;
      const window = text.slice(Math.max(0, idx - 100), idx + n.length + 100);
      if (FEMALE_SIGNALS.test(window)) { gender = "female"; break; }
      if (MALE_SIGNALS.test(window)) { gender = "male"; break; }
    }

    // Extract visual descriptors near name mentions
    const descParts: string[] = [];
    for (const n of allNames) {
      const regex = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const window = text.slice(Math.max(0, match.index - 60), match.index + n.length + 80);
        // Look for adjective-heavy descriptors
        const descMatch = window.match(
          /\b(trench coat|mask|porcelain|scarred|cracked|dark outfit|neon gum|red thread|silver hair|blonde|black coat|armed|weapon|gun)\b/gi
        );
        if (descMatch) descParts.push(...descMatch.map(d => d.toLowerCase()));
      }
    }

    characters.push({
      name,
      aliases,
      gender,
      description: [...new Set(descParts)].join(", "),
    });
  }

  return characters;
}

/* ------------------------------------------------------------------ */
/*  Scene parsing                                                      */
/* ------------------------------------------------------------------ */

/** Max characters per scene — long sections get split into sub-scenes */
const MAX_SCENE_CHARS = 800;

function splitIntoPages(text: string): { pageNum: number; text: string }[] {
  // Try structured markers: "Page N", "Chapter N", "CHAPTER N:", "Part N", "Scene N"
  const sectionRegex = /(?:^|\n)\s*(?:Page|Chapter|CHAPTER|Part|Scene|Act)\s*(\d+)\s*[:\-—.]?\s*[^\n]*/gi;
  const markers: { idx: number; num: number }[] = [];
  let pm: RegExpExecArray | null;
  while ((pm = sectionRegex.exec(text)) !== null) {
    markers.push({ idx: pm.index, num: parseInt(pm[1], 10) });
  }

  let rawSections: { pageNum: number; text: string }[] = [];

  if (markers.length >= 2) {
    for (let i = 0; i < markers.length; i++) {
      const start = markers[i].idx;
      const end = i + 1 < markers.length ? markers[i + 1].idx : text.length;
      // Strip the marker line itself
      const pageText = text.slice(start, end)
        .replace(/^[\s\S]*?\n/, "") // remove first line (the marker)
        .trim();
      if (pageText) rawSections.push({ pageNum: markers[i].num, text: pageText });
    }
  } else {
    // Fallback: split into chunks by paragraph groups
    const paragraphs = text.split(/\n{2,}/).filter(p => p.trim().length > 20);
    const targetScenes = Math.max(4, Math.min(8, Math.ceil(paragraphs.length / 3)));
    const chunkSize = Math.max(1, Math.ceil(paragraphs.length / targetScenes));
    for (let i = 0; i < paragraphs.length; i += chunkSize) {
      rawSections.push({
        pageNum: rawSections.length + 1,
        text: paragraphs.slice(i, i + chunkSize).join("\n\n").trim(),
      });
    }
  }

  if (rawSections.length === 0) {
    rawSections = [{ pageNum: 1, text: text.trim() }];
  }

  // Sub-split long sections so each scene maps to ~1 panel worth of content
  const result: { pageNum: number; text: string }[] = [];
  for (const section of rawSections) {
    if (section.text.length <= MAX_SCENE_CHARS) {
      result.push(section);
      continue;
    }

    // Split on paragraph breaks, grouping until we hit the limit
    const paras = section.text.split(/\n{1,}/).filter(p => p.trim().length > 0);
    let chunk = "";
    let subIdx = 0;
    for (const para of paras) {
      if (chunk.length + para.length > MAX_SCENE_CHARS && chunk.length > 0) {
        result.push({ pageNum: section.pageNum * 100 + subIdx, text: chunk.trim() });
        subIdx++;
        chunk = "";
      }
      chunk += para + "\n";
    }
    if (chunk.trim()) {
      result.push({ pageNum: section.pageNum * 100 + subIdx, text: chunk.trim() });
    }
  }

  return result;
}

function extractDialogue(text: string): string[] {
  // Match both straight quotes and curly/smart quotes
  const straight = text.match(/"([^"]+)"/g) ?? [];
  const curly = text.match(/\u201c([^\u201d]+)\u201d/g) ?? [];
  const combined = [...straight, ...curly];
  return combined
    .map(m => m.replace(/^[""\u201c]|[""\u201d]$/g, ""))
    .filter(d => d.length > 2);
}

function inferSetting(text: string): string {
  const lower = text.toLowerCase();
  const settingPatterns: [RegExp, string][] = [
    [/\b(rooftop|roof)\b/, "city rooftop at night"],
    [/\b(underground|beneath|metro|subway)\b/, "underground lair"],
    [/\b(theater|theatre|stage)\b/, "dark theater interior"],
    [/\b(street|alley|road)\b/, "dark city street"],
    [/\b(forest|woods|jungle)\b/, "dark forest"],
    [/\b(castle|fortress|tower)\b/, "gothic castle"],
    [/\b(office|desk|computer)\b/, "office interior"],
    [/\b(city|skyline|downtown)\b/, "dark city skyline"],
    [/\b(room|interior|inside)\b/, "dimly lit interior"],
    [/\b(night|darkness|shadow|dark)\b/, "moody night scene"],
  ];

  for (const [pattern, setting] of settingPatterns) {
    if (pattern.test(lower)) return setting;
  }
  return "dramatic scene";
}

function inferMood(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(fight|attack|explod|battle|chaos|lunged|shatter|crash)\b/.test(lower)) return "intense action";
  if (/\b(whisper|quiet|silence|calm|peace|rest)\b/.test(lower)) return "quiet tension";
  if (/\b(laugh|joke|humor|comedy|grin|smile)\b/.test(lower)) return "dark humor";
  if (/\b(reveal|discover|surprise|shock)\b/.test(lower)) return "dramatic reveal";
  if (/\b(chase|run|escape|flee)\b/.test(lower)) return "chase sequence";
  if (/\b(confront|face|standoff|stare)\b/.test(lower)) return "tense confrontation";
  return "dramatic";
}

function inferAction(text: string): string {
  // Try to find the most dynamic sentence
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
  const actionWords = /\b(kick|punch|run|jump|fight|shoot|throw|slam|flip|vault|charge|collide|drop|shatter|explode|burst|chase|stood|stare|step|walk|enter)\b/i;

  for (const s of sentences) {
    if (actionWords.test(s)) return s.slice(0, 120);
  }
  return sentences[0]?.slice(0, 120) ?? "";
}

function findCharactersInScene(
  sceneText: string,
  allCharacters: StoryCharacter[]
): string[] {
  const found: string[] = [];
  for (const char of allCharacters) {
    const names = [char.name, ...char.aliases];
    for (const n of names) {
      if (sceneText.includes(n)) {
        found.push(char.name);
        break;
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/*  Main parse function                                                */
/* ------------------------------------------------------------------ */

export function parseStory(text: string): ParsedStory {
  const cleaned = text.replace(/\r\n/g, "\n").trim();

  // Try to extract title from first line
  const firstLine = cleaned.split("\n")[0]?.trim() ?? "";
  const title =
    firstLine.length < 80 && firstLine.length > 2 && !/^Page\s+\d/i.test(firstLine)
      ? firstLine
      : "Untitled Story";

  const characters = extractCharacters(cleaned);
  const pages = splitIntoPages(cleaned);

  const scenes: StoryScene[] = pages.map(page => ({
    pageNumber: page.pageNum,
    narrative: page.text,
    setting: inferSetting(page.text),
    characters: findCharactersInScene(page.text, characters),
    action: inferAction(page.text),
    dialogue: extractDialogue(page.text),
    mood: inferMood(page.text),
  }));

  return { title, characters, scenes, fullText: cleaned };
}

/* ------------------------------------------------------------------ */
/*  Prompt + caption builders                                          */
/* ------------------------------------------------------------------ */

const styleModifiers: Record<ComicStyle, string> = {
  american: "classic american superhero comic book style, bold lines, vibrant dynamic colors",
  manga: "japanese manga style, black and white ink drawing, screentone shading",
  franco_belgian: "bande dessinee, ligne claire style, clear line drawing, tintin aesthetic, detailed background",
  manhwa: "korean webtoon manhwa style, high quality digital painting, aesthetic lighting",
  manhua: "chinese manhua style, wuxia fantasy aesthetic, intricate details",
};

export function buildScenePrompt(
  scene: StoryScene,
  characters: StoryCharacter[],
  style: ComicStyle,
): string {
  const parts: string[] = [];

  // ── COMPOSITION — describe the scene as a camera would see it ──
  parts.push("wide establishing shot of a scene showing the full environment");
  parts.push(`setting: ${scene.setting}`);

  // ── ACTION / MOOD — what is happening in this scene ──
  parts.push(`mood: ${scene.mood}`);

  if (scene.action) {
    const shortAction = scene.action
      .replace(/[""\u201c\u201d\u2018\u2019]/g, "")
      .split(",")[0]
      .trim()
      .slice(0, 80);
    parts.push(`action: ${shortAction}`);
  }

  // ── CHARACTERS — described within the scene, never as isolated portraits ──
  const sceneChars = characters.filter(c => scene.characters.includes(c.name));
  if (sceneChars.length > 0) {
    const charDescs = sceneChars.map(char => {
      const gender = char.gender === "female" ? "a woman" : char.gender === "male" ? "a man" : "a person";
      const desc = char.description ? ` wearing ${char.description}` : "";
      return `${gender}${desc}`;
    });
    parts.push(`characters in the scene: ${charDescs.join(" and ")}, shown full body from head to feet within the environment`);
  } else if (/\b(they|them|people|crowd|figures)\b/i.test(scene.narrative)) {
    parts.push("a group of people shown full body within the scene");
  }

  // ── STYLE ──
  parts.push(styleModifiers[style]);
  parts.push("comic book panel layout, detailed background, dynamic composition, high quality illustration");

  return parts.filter(Boolean).join(", ");
}

export function buildSceneCaption(scene: StoryScene): string {
  // Prefer actual dialogue from the scene
  if (scene.dialogue.length > 0) {
    // Pick the most impactful line (longest that fits)
    const best = scene.dialogue
      .filter(d => d.length > 5 && d.length < 150)
      .sort((a, b) => b.length - a.length)[0];
    if (best) return `"${best}"`;
  }

  // Fallback: use first compelling sentence from narrative
  const sentences = scene.narrative
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 15 && s.length < 120);

  // Prefer sentences with action or drama
  const dramatic = sentences.find(s =>
    /\b(stare|whisper|shout|scream|laugh|grin|silence|explod|shatter|darkness)\b/i.test(s)
  );
  if (dramatic) return dramatic + ".";

  return sentences[0] ? sentences[0] + "." : "...";
}

export function buildNegativePrompt(
  scene: StoryScene,
  characters: StoryCharacter[],
): string {
  const parts: string[] = [];

  // ── ANTI-PORTRAIT — this is the most important part ──
  parts.push("close-up, closeup, portrait, headshot, face only, bust shot, shoulders up, cropped, macro, head and shoulders, selfie, mugshot");

  const sceneChars = characters.filter(c => scene.characters.includes(c.name));

  // If all characters in scene are female, exclude male features
  if (sceneChars.length > 0 && sceneChars.every(c => c.gender === "female")) {
    parts.push("male, man, boy, masculine, beard, mustache");
  }
  // If all male, exclude female
  if (sceneChars.length > 0 && sceneChars.every(c => c.gender === "male")) {
    parts.push("female, woman, girl, feminine");
  }

  parts.push("blurry, low quality, watermark, text, logo");
  return parts.join(", ");
}
