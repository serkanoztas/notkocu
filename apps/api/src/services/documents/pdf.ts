import { extractText, getDocumentProxy } from "unpdf";
import { OcrError } from "../ai/errors";
import type { ExtractedDocument } from "./types";

/** Below this average per page (or when over half the pages are empty) the PDF counts as scanned. */
const MIN_AVG_CHARS_PER_PAGE = 40;
const MIN_PAGE_CHARS = 10;

export interface PdfTextResult {
  pageCount: number;
  /** The text layer is good enough to use; false means: send the PDF to Gemini. */
  usable: boolean;
  document: ExtractedDocument;
}

export async function extractPdfText(data: Uint8Array): Promise<PdfTextResult> {
  let pageTexts: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data)); // pdf.js may transfer the buffer, so give it a copy
    const res = await extractText(pdf, { mergePages: false });
    pageTexts = res.text.map((t) => t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
  } catch {
    throw new OcrError("PDF_UNREADABLE"); // encrypted or corrupt
  }
  const pageCount = pageTexts.length;
  const total = pageTexts.reduce((n, t) => n + t.length, 0);
  const empty = pageTexts.filter((t) => t.length < MIN_PAGE_CHARS).length;
  const usable = pageCount > 0 && total / pageCount >= MIN_AVG_CHARS_PER_PAGE && empty <= pageCount / 2;
  return { pageCount, usable, document: { unit: "page", pages: pageTexts } };
}
