import { NextRequest, NextResponse } from "next/server";

const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;

export async function POST(request: NextRequest) {
  const { narrative, action, mood, characters, dialogue, style } = await request.json();

  const styleVoice: Record<string, string> = {
    american: "bold, punchy, classic superhero comic book dialogue",
    manga: "expressive, dramatic, anime-style dialogue",
    franco_belgian: "witty, dry, bande dessinée style dialogue",
    manhwa: "emotional, intense, webtoon style dialogue",
    manhua: "poetic, dramatic, wuxia style dialogue",
  };

  const voice = styleVoice[style as string] ?? styleVoice.american;
  const existingDialogue = Array.isArray(dialogue) && dialogue.length > 0
    ? `Existing dialogue to draw from: "${dialogue[0]}"`
    : "";

  const systemPrompt = `You write comic book speech bubble text. Write a single short, punchy line (max 12 words) of ${voice}. Output ONLY the line of dialogue — no quotes, no attribution, no explanation.`;

  const userPrompt = `Scene: ${narrative?.slice(0, 300) ?? ""}
Setting: ${mood ?? "dramatic"}
Action: ${action ?? ""}
Characters: ${Array.isArray(characters) ? characters.join(", ") : ""}
${existingDialogue}

Write one comic book speech bubble line for this scene.`;

  try {
    const response = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(POLLINATIONS_API_KEY && { Authorization: `Bearer ${POLLINATIONS_API_KEY}` }),
      },
      body: JSON.stringify({
        model: "openai",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 40,
        temperature: 0.85,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return NextResponse.json({ caption: null }, { status: response.status });
    }

    const json = await response.json();
    const caption = json.choices?.[0]?.message?.content?.trim() ?? null;
    return NextResponse.json({ caption });
  } catch {
    return NextResponse.json({ caption: null }, { status: 502 });
  }
}

export const maxDuration = 20;
