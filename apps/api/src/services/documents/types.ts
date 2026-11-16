export type DocumentKind = "pdf" | "docx" | "pptx";
export type DocumentUnit = "page" | "slide" | "section";

export interface ExtractedDocument {
  unit: DocumentUnit;
  /** One entry per page / slide / section; may contain empty strings. */
  pages: string[];
}

export const DOCUMENT_MIME: Record<DocumentKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Hard cap on stored text per document (characters), so a huge file cannot bloat the note. */
export const MAX_DOCUMENT_CHARS = 300_000;
