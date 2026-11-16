import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

/** Largest single zip entry we are willing to inflate (zip-bomb guard). */
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
/** Total inflated bytes per document. */
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;

/** Entry names of a zip without inflating anything. Throws when the bytes are not a zip. */
export function listZipEntries(data: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(data, {
    filter: (f) => {
      names.push(f.name);
      return false;
    },
  });
  return names;
}

/** Inflates only the wanted entries, refusing oversized ones. Returns name -> UTF-8 text. */
export function readZipTexts(data: Uint8Array, wanted: (name: string) => boolean): Map<string, string> {
  let total = 0;
  const files = unzipSync(data, {
    filter: (f) => {
      if (!wanted(f.name)) return false;
      if (f.originalSize > MAX_ENTRY_BYTES) throw new Error("zip entry too large");
      total += f.originalSize;
      if (total > MAX_TOTAL_BYTES) throw new Error("zip content too large");
      return true;
    },
  });
  const out = new Map<string, string>();
  for (const [name, bytes] of Object.entries(files)) out.set(name, new TextDecoder("utf-8").decode(bytes));
  return out;
}

// XML with element order preserved: [{ "w:p": [ ...children ], ":@": { "@_attr": "v" } }, { "#text": "..." }]
export type XNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

export function parseXml(xml: string): XNode[] {
  return parser.parse(xml) as XNode[];
}

export const tagOf = (n: XNode): string => Object.keys(n).find((k) => k !== ":@") ?? "";
export const kids = (n: XNode): XNode[] => (Array.isArray(n[tagOf(n)]) ? (n[tagOf(n)] as XNode[]) : []);
export const attr = (n: XNode, name: string): string | undefined =>
  ((n[":@"] as Record<string, string> | undefined) ?? {})[`@_${name}`];

/** Depth-first search for elements with the given tag (does not descend into matches when `deep` is false). */
export function findAll(nodes: XNode[], tag: string, deep = true): XNode[] {
  const out: XNode[] = [];
  for (const n of nodes) {
    if (tagOf(n) === tag) {
      out.push(n);
      if (!deep) continue;
    }
    out.push(...findAll(kids(n), tag, deep));
  }
  return out;
}
