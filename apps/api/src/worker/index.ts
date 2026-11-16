import mongoose from "mongoose";
import { env } from "../config/env";
import { NoteItemModel } from "../models";
import { OcrError, QuotaError, ocrImage } from "../services/ai/imageOcr";
import { readFile } from "../services/files";
import { markWeeksStale } from "../services/notes";
import { claimNext, complete, defer, fail, sweepExhausted, type ClaimedNote } from "../services/queue";

// Separate process: `npm run worker`. Takes pending notes from MongoDB (see services/queue.ts).

const CONCURRENCY = 2;
const IDLE_MS = 2_000;
const SWEEP_EVERY_MS = 30_000;
const DEFAULT_IMAGE_TITLE = "Fotoğraf";

let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function processNote(note: ClaimedNote): Promise<void> {
  try {
    if (note.type !== "image") throw new OcrError("UNSUPPORTED_TYPE");
    const content = note.content as { fileKey?: string; mime?: string };
    if (!content.fileKey) throw new OcrError("FILE_MISSING");
    const file = await readFile(String(note.userId), content.fileKey);
    if (!file) throw new OcrError("FILE_MISSING");

    const ocr = await ocrImage({ data: file.data, mimeType: content.mime ?? file.mime });
    const saved = await complete(note, {
      extractedText: ocr.markdown || ocr.summary,
      aiSummary: ocr.summary,
      set: {
        "content.ocrMarkdown": ocr.markdown,
        ...(note.title === DEFAULT_IMAGE_TITLE && ocr.title ? { title: ocr.title } : {}),
      },
    });
    if (saved) await markWeeksStale(String(note.userId), [note]);
  } catch (err) {
    if (err instanceof QuotaError) return defer(note);
    const code = err instanceof OcrError ? err.code : "INTERNAL";
    if (!(err instanceof OcrError)) console.error("Worker job failed:", (err as Error).message);
    await fail(note, code);
  }
}

async function loop(index: number): Promise<void> {
  let lastSweep = 0;
  while (!stopping) {
    try {
      if (index === 0 && Date.now() - lastSweep > SWEEP_EVERY_MS) {
        lastSweep = Date.now();
        await sweepExhausted();
      }
      const note = await claimNext();
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

async function main() {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  await NoteItemModel.syncIndexes();
  console.log(`Worker started (concurrency ${CONCURRENCY})`);
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => loop(i)));
  await mongoose.disconnect();
  console.log("Worker stopped");
}

const stop = () => {
  stopping = true;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

main().catch((err) => {
  console.error("Worker crashed:", (err as Error).message);
  process.exit(1);
});
