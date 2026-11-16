import { listZipEntries } from "./zip";
import type { DocumentKind } from "./types";

/** Real document type from the bytes (the client-declared mime is not trusted); null = unsupported. */
export function sniffDocument(data: Buffer): DocumentKind | null {
  if (data.length < 8) return null;
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    try {
      const names = new Set(listZipEntries(data));
      if (names.has("word/document.xml")) return "docx";
      if (names.has("ppt/presentation.xml")) return "pptx";
    } catch {
      return null;
    }
  }
  return null;
}
