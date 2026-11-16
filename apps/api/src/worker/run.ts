import { OcrError, QuotaError, ocrImage } from "../services/ai/imageOcr";
import { processDocument } from "../services/documents/process";
import { readFile } from "../services/files";
import { markWeeksStale } from "../services/notes";
import { claimNext, complete, defer, fail, sweepExhausted, type ClaimedNote } from "../services/queue";

// The job loops, without any process-level side effects, so the check scripts can run them in-process.
// The real entry point (connect, signals) is worker/index.ts.

const IDLE_MS = 2_000;
const SWEEP_EVERY_MS = 30_000;
const DEFAULT_IMAGE_TITLE = "Fotoğraf";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadFile(note: ClaimedNote) {
  const content = note.content as { fileKey?: string; mime?: string };
  if (!content.fileKey) throw new OcrError("FILE_MISSING");
  const file = await readFile(String(note.userId), content.fileKey);
  if (!file) throw new OcrError("FILE_MISSING");
  return { file, mime: content.mime ?? file.mime };
}

async function processImageNote(note: ClaimedNote): Promise<boolean> {
  const { file, mime } = await loadFile(note);
  const ocr = await ocrImage({ data: file.data, mimeType: mime });
  return complete(note, {
    extractedText: ocr.markdown || ocr.summary,
    aiSummary: ocr.summary,
    set: {
      "content.ocrMarkdown": ocr.markdown,
      ...(note.title === DEFAULT_IMAGE_TITLE && ocr.title ? { title: ocr.title } : {}),
    },
  });
}

async function processDocumentNote(note: ClaimedNote): Promise<boolean> {
  const { file } = await loadFile(note);
  const doc = await processDocument(file.data);
  return complete(note, {
    extractedText: doc.text || note.title,
    aiSummary: doc.summary,
    set: { "content.pages": doc.pages, "content.pageCount": doc.pageCount, "content.unit": doc.unit },
  });
}

async function processNote(note: ClaimedNote): Promise<void> {
  try {
    let saved: boolean;
    if (note.type === "image") saved = await processImageNote(note);
    else if (note.type === "document") saved = await processDocumentNote(note);
    else throw new OcrError("UNSUPPORTED_TYPE");
    if (saved) await markWeeksStale(String(note.userId), [note]);
  } catch (err) {
    if (err instanceof QuotaError) return defer(note);
    const code = err instanceof OcrError ? err.code : "INTERNAL";
    if (!(err instanceof OcrError)) console.error("Worker job failed:", (err as Error).message);
    await fail(note, code);
  }
}

export interface WorkerOptions {
  concurrency: number;
  /** Extra claim filter (the check scripts use it to take only their own throw-away notes). */
  claimFilter?: Record<string, unknown>;
}

/** Starts the job loops; resolves `stop()` once every loop has finished its current job. */
export function startWorker(opts: WorkerOptions): { stop: () => Promise<void> } {
  let stopping = false;

  async function loop(index: number): Promise<void> {
    let lastSweep = 0;
    while (!stopping) {
      try {
        if (index === 0 && Date.now() - lastSweep > SWEEP_EVERY_MS) {
          lastSweep = Date.now();
          await sweepExhausted();
        }
        const note = await claimNext(opts.claimFilter);
        if (!note) {
          await sleep(IDLE_MS);
          continue;
        }
        await processNote(note);
      } catch (err) {
        console.error("Worker loop error:", (err as Error).message);
        await sleep(IDLE_MS);
      }
    }
  }

  const loops = Array.from({ length: opts.concurrency }, (_, i) => loop(i));
  return {
    stop: async () => {
      stopping = true;
      await Promise.all(loops);
    },
  };
}
