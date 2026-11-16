import { ocrPdfPages } from "../ai/documentOcr";
import { summarizeDocumentText } from "../ai/documentSummary";
import { OcrError } from "../ai/errors";
import { extractDocx } from "./docx";
import { extractPdfText } from "./pdf";
import { extractPptx } from "./pptx";
import { sniffDocument } from "./sniff";
import { MAX_DOCUMENT_CHARS, type DocumentUnit } from "./types";

export interface ProcessedDocument {
  unit: DocumentUnit;
  pages: string[];
  pageCount: number;
  /** All pages joined (capped). */
  text: string;
  summary: string;
  /** true when the PDF went to Gemini because it had no usable text layer. */
  scanned: boolean;
}

/** Keeps whole pages until the character cap is reached (the rest is dropped, the count stays true). */
function capPages(pages: string[]): string[] {
  let used = 0;
  return pages.map((p) => {
    if (used >= MAX_DOCUMENT_CHARS) return "";
    const room = MAX_DOCUMENT_CHARS - used;
    const kept = p.length > room ? p.slice(0, room) : p;
    used += kept.length;
    return kept;
  });
}

/** Extracts per-page text (DOCX/PPTX/PDF text layer in JS, scanned PDF via Gemini) and a summary. */
export async function processDocument(data: Buffer): Promise<ProcessedDocument> {
  const kind = sniffDocument(data);
  if (!kind) throw new OcrError("UNSUPPORTED_DOCUMENT");

  let unit: DocumentUnit;
  let pages: string[];
  let scanned = false;
  try {
    if (kind === "docx") ({ unit, pages } = extractDocx(data));
    else if (kind === "pptx") ({ unit, pages } = extractPptx(data));
    else {
      const pdf = await extractPdfText(data);
      if (pdf.usable) {
        unit = "page";
        pages = pdf.document.pages;
      } else {
        scanned = true;
        unit = "page";
        pages = await ocrPdfPages(data);
      }
    }
  } catch (err) {
    if (err instanceof OcrError || (err as Error).name === "QuotaError") throw err;
    throw new OcrError("DOCUMENT_UNREADABLE");
  }

  pages = capPages(pages);
  const text = pages.filter(Boolean).join("\n\n").trim();
  const summary = text
    ? await summarizeDocumentText(text)
    : "Belgede okunabilir metin bulunamadı.";
  return { unit, pages, pageCount: pages.length, text, summary, scanned };
}
