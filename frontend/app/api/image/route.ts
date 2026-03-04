import { NextRequest, NextResponse } from "next/server";

const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const prompt = searchParams.get("prompt");
  const seed = searchParams.get("seed") ?? "1";
  const width = searchParams.get("width") ?? "1024";
  const height = searchParams.get("height") ?? "1024";
  const negativePrompt = searchParams.get("negative_prompt") ?? "";

  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const encodedPrompt = encodeURIComponent(prompt);
  const params = new URLSearchParams({
    model: "zimage",
    seed,
    width,
    height,
    nologo: "true",
    enhance: "true",
  });
  if (negativePrompt) params.set("negative_prompt", negativePrompt);

  const upstreamUrl = `https://gen.pollinations.ai/image/${encodedPrompt}?${params}`;

  try {
    const response = await fetch(upstreamUrl, {
      headers: {
        ...(POLLINATIONS_API_KEY && { Authorization: `Bearer ${POLLINATIONS_API_KEY}` }),
      },
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      console.error(`Pollinations returned ${response.status} for prompt: ${prompt}`);
      return NextResponse.json(
        { error: `Upstream error: ${response.status}` },
        { status: response.status }
      );
    }

    const imageBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "image/jpeg";

    return new NextResponse(imageBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    console.error("Image proxy error:", err);
    return NextResponse.json({ error: "Failed to fetch image" }, { status: 502 });
  }
}

export const maxDuration = 60;
