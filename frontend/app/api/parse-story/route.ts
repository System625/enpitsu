import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const arrayBuf = await file.arrayBuffer();
  const name = file.name.toLowerCase();

  try {
    if (name.endsWith(".txt")) {
      const text = new TextDecoder().decode(arrayBuf);
      return NextResponse.json({ text });
    }

    if (name.endsWith(".pdf")) {
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

      // Point worker to the actual worker file so pdfjs doesn't complain
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/legacy/build/pdf.worker.mjs",
        import.meta.url
      ).toString();

      const data = new Uint8Array(arrayBuf);
      const doc = await pdfjsLib.getDocument({
        data,
        useWorkerFetch: false,
        isEvalSupported: false,
        useSystemFonts: true,
      }).promise;

      let fullText = "";

      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        let lastY: number | null = null;
        let pageText = "";

        for (const item of content.items) {
          if ("str" in item) {
            const y = item.transform[5];
            if (lastY !== null && Math.abs(y - lastY) > 1) {
              pageText += "\n";
            }
            pageText += item.str;
            lastY = y;
          }
        }

        fullText += pageText + "\n\n";
      }

      doc.destroy();
      return NextResponse.json({ text: fullText });
    }

    if (name.endsWith(".docx") || name.endsWith(".doc")) {
      const mammoth = await import("mammoth");
      const buffer = Buffer.from(arrayBuf);
      const result = await mammoth.extractRawText({ buffer });
      return NextResponse.json({ text: result.value });
    }

    // Fallback: attempt raw text decode
    const text = new TextDecoder().decode(arrayBuf);
    return NextResponse.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Story parse error:", message);
    return NextResponse.json(
      { error: "Failed to extract text from file", detail: message },
      { status: 500 }
    );
  }
}
