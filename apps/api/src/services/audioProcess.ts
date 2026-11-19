import type { AudioChunk } from "@notkocu/shared";
import { OcrError } from "./ai/errors";
import { chaptersAndSummary, transcribeChunk, type Segment } from "./ai/audioTranscribe";
import { readFile } from "./files";
import { complete, saveProgress, type ClaimedNote } from "./queue";

// Worker side of an audio note: transcript piece by piece (each finished piece is saved, so a retry only
// redoes the piece that failed), then chapters + summary from the transcript text.

const MAX_EXTRACTED_CHARS = 300_000;
const NO_SPEECH_SUMMARY = "Kayıtta konuşma algılanmadı.";

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

export async function processAudio(note: ClaimedNote): Promise<boolean> {
  const content = note.content as { chunks?: AudioChunk[]; durationSec?: number };
  const chunks = content.chunks ?? [];
  if (chunks.length === 0) throw new OcrError("FILE_MISSING");

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

  const transcript = globalTranscript(chunks, perChunk);
  const durationSec = content.durationSec ?? chunks.reduce((n, c) => n + c.durationSec, 0);
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
