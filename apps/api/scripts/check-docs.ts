// Offline check of the document extractors (no database, no Gemini): builds small DOCX / PPTX / PDF
// files in memory and verifies sniffing, page/slide splitting, the scanned-PDF decision and the zip guards.
// Run: npm run check-docs
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractDocx } from "../src/services/documents/docx";
import { extractPdfText } from "../src/services/documents/pdf";
import { extractPptx } from "../src/services/documents/pptx";
import { sniffDocument } from "../src/services/documents/sniff";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures += 1;
}

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const para = (t: string, extra = "") => `<w:p><w:r>${extra}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

function docx(body: string): Buffer {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
    }),
  );
}

function pptx(slides: string[][], notes: Record<number, string> = {}): Buffer {
  const A = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(
      `<p:presentation ${A}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).reverse().join("")}</p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
    ),
  };
  slides.forEach((paras, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(
      `<p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody>${paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}<a:p><a:fld type="slidenum"><a:t>${i + 1}</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
    if (notes[i]) {
      files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(
        `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`,
      );
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = strToU8(`<p:notes ${A}><a:p><a:r><a:t>${notes[i]}</a:t></a:r></a:p></p:notes>`);
    }
  });
  return Buffer.from(zipSync(files));
}

async function pdf(pageTexts: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of pageTexts) {
    const page = doc.addPage([400, 400]);
    if (t) page.drawText(t, { x: 20, y: 350, size: 12, font, maxWidth: 360, lineHeight: 14 });
  }
  return Buffer.from(await doc.save());
}

async function main() {
  const longText = "Normalizasyon ve fonksiyonel bagimlilik uzerine ornek anlatim metni. ".repeat(4);

  // --- sniffing ---
  const d1 = docx(para("Merhaba"));
  check("sniff docx", sniffDocument(d1) === "docx");
  check("sniff pptx", sniffDocument(pptx([["a"]])) === "pptx");
  check("sniff pdf", sniffDocument(await pdf([longText])) === "pdf");
  check("sniff rejects random zip", sniffDocument(Buffer.from(zipSync({ "a.txt": strToU8("hello world") }))) === null);
  check("sniff rejects text", sniffDocument(Buffer.from("this is just a text file, not a document")) === null);
  check("sniff rejects legacy .doc (OLE)", sniffDocument(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])) === null);

  // --- DOCX ---
  const withBreaks = extractDocx(docx(para("Birinci sayfa") + para("devam", `<w:br w:type="page"/>`) + para("Ucuncu", `<w:lastRenderedPageBreak/>`)));
  check("docx explicit page breaks -> pages", withBreaks.unit === "page" && withBreaks.pages.length === 3, JSON.stringify(withBreaks.pages));
  const long = extractDocx(docx(Array.from({ length: 40 }, (_, i) => para(`Paragraf ${i}. ` + "x".repeat(300))).join("")));
  check("docx without breaks -> sections", long.unit === "section" && long.pages.length > 1 && long.pages.every((p) => p.length <= 3400));

  // --- PPTX ---
  const slides = extractPptx(pptx([["Baslik 1", "madde"], ["Baslik 2"], ["Baslik 3"]], { 1: "konusma notu" }));
  // The fixture lists the slides in reverse in presentation.xml: the order must follow it, not the file names.
  check("pptx slides in presentation order", slides.unit === "slide" && slides.pages.length === 3 && slides.pages[0]!.startsWith("Baslik 3") && slides.pages[2]!.startsWith("Baslik 1"), JSON.stringify(slides.pages));
  check("pptx notes included, slide number field dropped", slides.pages[1]!.includes("konusma notu") && !slides.pages[2]!.split("\n").includes("1"));

  // --- PDF text layer vs scanned ---
  const textPdf = await extractPdfText(await pdf([longText, longText, longText]));
  check("text pdf usable, 3 pages", textPdf.usable && textPdf.pageCount === 3 && textPdf.document.pages[0]!.includes("Normalizasyon"));
  const scanned = await extractPdfText(await pdf(["", "", ""]));
  check("blank-text pdf counts as scanned", !scanned.usable && scanned.pageCount === 3);
  const mostlyEmpty = await extractPdfText(await pdf([longText, "", "", ""]));
  check("mostly empty pdf counts as scanned", !mostlyEmpty.usable);

  // --- zip guards ---
  const bomb = Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": new Uint8Array(60 * 1024 * 1024).fill(97) }));
  check("bomb is small on disk", bomb.length < 1024 * 1024, `${bomb.length} bytes`);
  check("bomb is rejected", (() => { try { extractDocx(bomb); return false; } catch { return true; } })());
  check("corrupt zip is not a document", sniffDocument(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("garbage garbage garbage")])) === null);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
