import { attr, findAll, kids, parseXml, readZipTexts, tagOf, type XNode } from "./zip";
import type { ExtractedDocument } from "./types";

const PAGE_BREAK = "\f";
/** DOCX has no pages without rendering: without explicit breaks, text is cut into sections of about this size. */
const SECTION_CHARS = 3000;

/** Text of one paragraph; page breaks become "\f". */
function paragraphText(nodes: XNode[]): string {
  let out = "";
  for (const n of nodes) {
    const tag = tagOf(n);
    if (tag === "#text") {
      out += String(n["#text"] ?? "");
    } else if (tag === "w:t") {
      out += kids(n).map((c) => String(c["#text"] ?? "")).join("");
    } else if (tag === "w:tab") {
      out += "\t";
    } else if (tag === "w:br" || tag === "w:cr") {
      out += attr(n, "w:type") === "page" ? PAGE_BREAK : "\n";
    } else if (tag === "w:lastRenderedPageBreak") {
      out += PAGE_BREAK;
    } else if (tag === "w:instrText" || tag === "w:delText") {
      // field codes and deleted text are not content
    } else {
      out += paragraphText(kids(n));
    }
  }
  return out;
}

function chunkSections(paragraphs: string[]): string[] {
  const sections: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length > SECTION_CHARS) {
      sections.push(current.trim());
      current = "";
    }
    current += `${p}\n`;
  }
  if (current.trim()) sections.push(current.trim());
  return sections;
}

export function extractDocx(data: Uint8Array): ExtractedDocument {
  const files = readZipTexts(data, (name) => name === "word/document.xml");
  const xml = files.get("word/document.xml");
  if (!xml) throw new Error("word/document.xml missing");

  // Top-level paragraphs only (w:p inside tables are found through their table rows anyway).
  const paragraphs = findAll(parseXml(xml), "w:p", false).map((p) => paragraphText(kids(p)));

  const hasBreaks = paragraphs.some((p) => p.includes(PAGE_BREAK));
  if (hasBreaks) {
    const pages = paragraphs
      .join("\n")
      .split(PAGE_BREAK)
      .map((p) => p.replace(/\n{3,}/g, "\n\n").trim())
      .filter((p) => p.length > 0);
    if (pages.length > 0) return { unit: "page", pages };
  }
  return { unit: "section", pages: chunkSections(paragraphs.map((p) => p.replace(new RegExp(PAGE_BREAK, "g"), ""))) };
}
