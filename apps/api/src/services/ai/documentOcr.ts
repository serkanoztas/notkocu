import { FileState, Type, type Part, type Schema } from "@google/genai";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { OcrError, toAiError } from "./errors";
import { geminiTask, getGemini } from "./gemini";

// Scanned PDFs (no usable text layer) go to Gemini as PDF, in chunks of CHUNK_PAGES pages.
// Same model / thinking / schema / log-privacy rules as the image OCR. Never log text or bytes.

export const MAX_SCANNED_PAGES = 60;
const CHUNK_PAGES = 10;
/** Inline request bodies are capped at ~20 MB including base64; above this the Files API is used. */
export const INLINE_LIMIT_BYTES = 14 * 1024 * 1024;

const SYSTEM_PROMPT = `Sen bir üniversite öğrencisinin ders belgelerini (taranmış PDF, slayt, ders notu) okuyan bir asistansın. Belge Türkçe ya da İngilizce olabilir.

Kurallar:
- Verilen PDF'in her sayfasını sırayla oku ve her sayfanın metnini düzenli Markdown olarak "pages" dizisine ayrı eleman olarak yaz. Dizide PDF'teki sayfa sayısı kadar eleman olsun.
- Başlıklar, madde listeleri, tablolar ve formüller uygun biçimde yazılsın.
- Yalnızca sayfada olanı yaz; tamamlama, uydurma. Okunamayan yeri atla ya da [okunamadı] yaz.
- Metni olmayan sayfa için boş string ver.`;

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: { pages: { type: Type.ARRAY, items: { type: Type.STRING } } },
  required: ["pages"],
};

const resultZ = z.object({ pages: z.array(z.string()) });

async function splitPdf(src: PDFDocument, from: number, to: number): Promise<Uint8Array> {
  const part = await PDFDocument.create();
  const indices = Array.from({ length: to - from }, (_, i) => from + i);
  for (const page of await part.copyPages(src, indices)) part.addPage(page);
  return part.save();
}

async function uploadToFilesApi(bytes: Uint8Array): Promise<{ name: string; uri: string }> {
  const ai = getGemini();
  const uploaded = await ai.files.upload({
    file: new Blob([Buffer.from(bytes)], { type: "application/pdf" }),
    config: { mimeType: "application/pdf" },
  });
  let file = uploaded;
  for (let i = 0; i < 30 && file.state === FileState.PROCESSING; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    file = await ai.files.get({ name: file.name! });
  }
  if (!file.name || !file.uri || file.state === FileState.FAILED) throw new OcrError("AI_FILE_UPLOAD");
  return { name: file.name, uri: file.uri };
}

/** One chunk -> exactly `count` page texts (padded / merged if the model miscounted). */
async function ocrChunk(bytes: Uint8Array, count: number, forceFilesApi: boolean): Promise<string[]> {
  const ai = getGemini();
  let uploadedName: string | undefined;
  let text: string | undefined;
  try {
    let pdfPart: Part;
    if (forceFilesApi || bytes.length > INLINE_LIMIT_BYTES) {
      const up = await uploadToFilesApi(bytes);
      uploadedName = up.name;
      pdfPart = { fileData: { fileUri: up.uri, mimeType: "application/pdf" } };
    } else {
      pdfPart = { inlineData: { mimeType: "application/pdf", data: Buffer.from(bytes).toString("base64") } };
    }
    const { model, thinkingConfig } = geminiTask("ocr");
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [pdfPart, { text: `Bu PDF ${count} sayfa. Her sayfanın metnini çıkar.` }] }],
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
    if (err instanceof OcrError) throw err;
    throw toAiError(err, "PDF OCR");
  } finally {
    if (uploadedName) await ai.files.delete({ name: uploadedName }).catch(() => undefined); // do not leave documents at the provider
  }

  let pages: string[];
  try {
    pages = resultZ.parse(JSON.parse(text ?? "")).pages.map((p) => p.trim());
  } catch {
    throw new OcrError("AI_BAD_OUTPUT");
  }
  if (pages.length > count) pages = [...pages.slice(0, count - 1), pages.slice(count - 1).join("\n\n")];
  while (pages.length < count) pages.push("");
  return pages;
}

/** Page texts of a scanned PDF. Throws OcrError("TOO_LONG") above MAX_SCANNED_PAGES. */
export async function ocrPdfPages(data: Buffer, opts: { forceFilesApi?: boolean } = {}): Promise<string[]> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(data);
  } catch {
    throw new OcrError("PDF_UNREADABLE");
  }
  const total = src.getPageCount();
  if (total > MAX_SCANNED_PAGES) throw new OcrError("TOO_LONG");

  const pages: string[] = [];
  for (let from = 0; from < total; from += CHUNK_PAGES) {
    const to = Math.min(total, from + CHUNK_PAGES);
    pages.push(...(await ocrChunk(await splitPdf(src, from, to), to - from, !!opts.forceFilesApi)));
  }
  return pages;
}
