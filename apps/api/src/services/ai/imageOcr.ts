import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { OcrError, toAiError } from "./errors";
import { generateContent, geminiTask } from "./gemini";

export { OcrError, QuotaError } from "./errors";

const SYSTEM_PROMPT = `Sen bir üniversite öğrencisinin ders notu fotoğraflarını okuyan bir asistansın. Görsel bir tahta, slayt, kitap sayfası, defter ya da ekran görüntüsü olabilir (Türkçe ya da İngilizce).

Kurallar:
- Görseldeki yazıyı düzenli Markdown'a çevir: başlıklar, madde listeleri, tablolar ve formüller uygun biçimde yazılsın. Okuma sırası doğal sıra olsun.
- Yalnızca görselde olanı yaz; eksik kısmı tamamlama, uydurma. Okunamayan yeri atla ya da [okunamadı] yaz.
- Görselde okunacak metin yoksa "markdown" boş string olsun ve "summary" görselde ne olduğunu kısaca anlatsın.
- "title": notu anlatan en fazla 60 karakterlik kısa bir başlık.
- "summary": 1-2 cümlelik Türkçe özet.`;

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    markdown: { type: Type.STRING },
    title: { type: Type.STRING },
    summary: { type: Type.STRING },
  },
  required: ["markdown", "title", "summary"],
};

const resultZ = z.object({
  markdown: z.string(),
  title: z.string(),
  summary: z.string(),
});

export interface OcrResult {
  markdown: string;
  title: string;
  summary: string;
}

/**
 * OCR + Markdown for one image. No retry loop here: the queue retries. Logs only the HTTP status,
 * never the image, the response or the key.
 */
export async function ocrImage(image: { data: Buffer; mimeType: string }): Promise<OcrResult> {
  let text: string | undefined;
  try {
    const { model, thinkingConfig } = geminiTask("ocr");
    const res = await generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: image.mimeType, data: image.data.toString("base64") } },
            { text: "Bu görseldeki notu Markdown'a çevir." },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0,
        thinkingConfig,
      },
    });
    text = res.text;
  } catch (err) {
    throw toAiError(err, "OCR");
  }

  try {
    const parsed = resultZ.parse(JSON.parse(text ?? ""));
    const markdown = parsed.markdown.trim();
    const summary = parsed.summary.trim();
    if (!markdown && !summary) throw new Error("empty");
    return { markdown, title: parsed.title.trim().slice(0, 120), summary };
  } catch {
    throw new OcrError("AI_BAD_OUTPUT");
  }
}
