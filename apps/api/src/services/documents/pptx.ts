import { attr, findAll, kids, parseXml, readZipTexts, tagOf, type XNode } from "./zip";
import type { ExtractedDocument } from "./types";

function runsText(nodes: XNode[]): string {
  let out = "";
  for (const n of nodes) {
    const tag = tagOf(n);
    if (tag === "#text") out += String(n["#text"] ?? "");
    else if (tag === "a:t") out += kids(n).map((c) => String(c["#text"] ?? "")).join("");
    else if (tag === "a:br") out += "\n";
    else if (tag === "a:fld") continue; // slide numbers and dates, not content
    else out += runsText(kids(n));
  }
  return out;
}

/** All paragraphs (a:p) of a slide or notes part, one per line. */
function partText(xml: string): string {
  return findAll(parseXml(xml), "a:p", false)
    .map((p) => runsText(kids(p)).trim())
    .filter(Boolean)
    .join("\n");
}

const normalizePath = (base: string, target: string): string => {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
};

function relationships(xml: string | undefined, basePath: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  if (!xml) return map;
  for (const r of findAll(parseXml(xml), "Relationship")) {
    const id = attr(r, "Id");
    const target = attr(r, "Target");
    if (id && target) map.set(id, { target: normalizePath(basePath, target), type: attr(r, "Type") ?? "" });
  }
  return map;
}

export function extractPptx(data: Uint8Array): ExtractedDocument {
  const files = readZipTexts(data, (n) => /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/[^/]+\.xml|slides\/_rels\/[^/]+\.rels|notesSlides\/[^/]+\.xml)$/.test(n));
  const presentation = files.get("ppt/presentation.xml");
  if (!presentation) throw new Error("ppt/presentation.xml missing");

  const rels = relationships(files.get("ppt/_rels/presentation.xml.rels"), "ppt/presentation.xml");
  const slidePaths = findAll(parseXml(presentation), "p:sldId")
    .map((s) => attr(s, "r:id"))
    .map((rid) => (rid ? rels.get(rid)?.target : undefined))
    .filter((p): p is string => !!p);

  const pages = slidePaths.map((path) => {
    const slideXml = files.get(path);
    const text = slideXml ? partText(slideXml) : "";
    const relPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
    const notesTarget = [...relationships(files.get(relPath), path).values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
    const notesXml = notesTarget ? files.get(notesTarget) : undefined;
    const notes = notesXml ? partText(notesXml) : "";
    return notes ? `${text}\n\nNotlar: ${notes}`.trim() : text;
  });
  return { unit: "slide", pages };
}
