import type { AudioChunk } from "@notkocu/shared";
import { OcrError, toAiError } from "./ai/errors";
import { chaptersAndSummary, transcribeChunk, type Segment } from "./ai/audioTranscribe";
import { transcribeImported, type ImportedProgress } from "./ai/audioImportTranscribe";
import { deleteFromFilesApi, getUsableFile, uploadToFilesApi, type UploadedFile } from "./ai/filesApi";
import { reserveAudioBudget } from "./audioBudget";
import { readFile } from "./files";
import { complete, deferBudget, extendLease, MAX_ATTEMPTS, saveProgress, type ClaimedNote } from "./queue";

// Worker side of an audio note.
// - A recording made in the app: transcript piece by piece (each finished piece is saved, so a retry only
//   redoes the piece that failed).
// - An imported file (content.imported): ONE file, uploaded once to the Files API and transcribed in one
//   request that is continued from its last time stamp when the answer hits the output limit; every request's
//   result is saved, so a retry continues instead of starting over (see transcribeImported).
// Then chapters + summary from the transcript text. Both kinds first reserve the user's daily audio budget.

const MAX_EXTRACTED_CHARS = 300_000;
const NO_SPEECH_SUMMARY = "Kayıtta konuşma algılanmadı.";
/** Processing a big upload at the provider can take a while (seconds of waiting, lease extended around it). */
const UPLOAD_WAIT_SEC = 120;

/** Local piece times -> one global, ordered transcript with end times. */
function globalTranscript(chunks: AudioChunk[], perChunk: Segment[][]) {
  const out: { startSec: number; endSec: number; text: string }[] = [];
  for (const [i, segments] of perChunk.entries()) {
    const chunk = chunks[i]!;
    const chunkEnd = chunk.startSec + chunk.durationSec;
    for (const [j, s] of segments.entries()) {
      const next = segments[j + 1];
      const start = chunk.startSec + s.startSec;
      out.push({ startSec: start, endSec: Math.max(start, next ? chunk.startSec + next.startSec : chunkEnd), text: s.text });
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

async function finish(note: ClaimedNote, transcript: ReturnType<typeof globalTranscript>, durationSec: number) {
  const { chapters, summary } =
    transcript.length > 0
      ? await chaptersAndSummary(transcript, durationSec)
      : { chapters: [], summary: NO_SPEECH_SUMMARY };

  return complete(note, {
    extractedText: transcript.map((t) => t.text).join("\n").slice(0, MAX_EXTRACTED_CHARS),
    aiSummary: summary,
    set: { "content.transcript": transcript, "content.chapters": chapters },
  });
}

export async function processAudio(note: ClaimedNote): Promise<boolean> {
  const content = note.content as { chunks?: AudioChunk[]; durationSec?: number; imported?: boolean };
  const chunks = content.chunks ?? [];
  if (chunks.length === 0) throw new OcrError("FILE_MISSING");
  const durationSec = content.durationSec ?? chunks.reduce((n, c) => n + c.durationSec, 0);

  // Daily budget first: over budget the note waits for the user's next day (no attempt or deferral is used).
  const budget = await reserveAudioBudget(note, durationSec);
  if (!budget.ok) {
    await deferBudget(note, budget.retryAt);
    return false;
  }
  if (content.imported) return processImported(note, chunks[0]!, durationSec);

  // Pieces finished by an earlier attempt are kept in job.progress (server-only bookkeeping).
  const saved = (note.job as { progress?: Record<string, Segment[]> } | undefined)?.progress ?? {};
  const perChunk: Segment[][] = [];
  for (const [i, chunk] of chunks.entries()) {
    const known = saved[String(i)];
    if (Array.isArray(known)) {
      perChunk.push(known);
      continue;
    }
    if (!chunk.fileKey) throw new OcrError("AUDIO_DELETED");
    const file = await readFile(String(note.userId), chunk.fileKey);
    if (!file) throw new OcrError("FILE_MISSING");
    const segments = await transcribeChunk(file.data, chunk.mime || file.mime, chunk.durationSec);
    await saveProgress(note, String(i), segments); // also extends the lease: long recordings outlast the 3 min default
    perChunk.push(segments);
  }

  return finish(note, globalTranscript(chunks, perChunk), durationSec);
}

async function processImported(note: ClaimedNote, chunk: AudioChunk, durationSec: number): Promise<boolean> {
  if (!chunk.fileKey) throw new OcrError("AUDIO_DELETED");
  const progress = (note.job as { progress?: { file?: UploadedFile; seg?: ImportedProgress } } | undefined)?.progress;
  let uploaded: UploadedFile | null = progress?.file ? await getUsableFile(progress.file) : null;
  let finished = false;
  try {
    let segments: Segment[];
    if (progress?.seg?.complete) {
      segments = progress.seg.segments; // only the chapters/summary step is left
    } else {
      if (!uploaded) {
        await extendLease(note);
        const file = await readFile(String(note.userId), chunk.fileKey);
        if (!file) throw new OcrError("FILE_MISSING");
        try {
          uploaded = await uploadToFilesApi(file.data, chunk.mime || file.mime, UPLOAD_WAIT_SEC);
        } catch (err) {
          throw err instanceof OcrError ? err : toAiError(err, "audio upload");
        }
        await saveProgress(note, "file", uploaded);
      }
      segments = await transcribeImported({
        file: uploaded,
        durationSec,
        resume: progress?.seg,
        beforeRequest: () => extendLease(note),
        onProgress: (p) => saveProgress(note, "seg", p),
      });
    }
    const saved = await finish(note, globalTranscript([chunk], [segments]), durationSec);
    finished = saved;
    return saved;
  } finally {
    // Kept between attempts (a retry reuses the upload); removed when the job is done or out of attempts.
    const name = uploaded?.name ?? progress?.file?.name;
    if (name && (finished || (note.job?.attempts ?? 0) >= MAX_ATTEMPTS)) await deleteFromFilesApi(name);
  }
}
