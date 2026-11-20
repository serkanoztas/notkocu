// Audio recordings are stored as separate pieces (see AudioContent.chunks), but the transcript, the
// chapters and every "jump to" use ONE global timeline (seconds from the start of the recording).
// This file is the only place that converts between the two.

/** Pieces are ~10 min; the app rolls over to a new piece at this length. */
export const AUDIO_CHUNK_SEC = 600;
/** Whole upload (all pieces) must stay under this many bytes. */
export const AUDIO_MAX_TOTAL_BYTES = 60 * 1024 * 1024;
export const AUDIO_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const AUDIO_MAX_CHUNKS = 24;
/** Audio files are deleted this many days after the note is created, unless pinned. */
export const AUDIO_RETENTION_DAYS = 30;
/** Un-pinning never leaves less than this many days before deletion. */
export const AUDIO_UNPIN_GRACE_DAYS = 7;

/** An imported file (one piece, any supported format) may be up to this big. */
export const AUDIO_IMPORT_MAX_BYTES = 100 * 1024 * 1024;
/** Fallback for AUDIO_MAX_PROCESS_MIN when the app cannot reach the API setting. */
export const AUDIO_MAX_PROCESS_MIN_DEFAULT = 120;
/** Extensions the app offers to import (the server decides by the first bytes, not by this). */
export const AUDIO_IMPORT_EXTENSIONS = ["opus", "ogg", "oga", "m4a", "mp3", "wav", "flac", "aac"] as const;

export interface TimedChunk {
  startSec: number;
  durationSec: number;
}

/** Start times from the piece durations, in order: [0, d0, d0+d1, ...]. */
export function chunkStarts(durations: number[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const d of durations) {
    out.push(at);
    at += d;
  }
  return out;
}

export function totalDuration(chunks: TimedChunk[]): number {
  const last = chunks[chunks.length - 1];
  return last ? last.startSec + last.durationSec : 0;
}

/**
 * Which piece holds global time \`t\`, and where inside it. A time that sits exactly on a boundary belongs to
 * the NEXT piece (local 0), so a jump to a chapter that starts at a boundary opens the right file.
 * Times before 0 give the start; times past the end give the end of the last piece.
 */
export function locateChunk(chunks: TimedChunk[], t: number): { index: number; localSec: number } | null {
  if (chunks.length === 0) return null;
  const time = Math.max(0, t);
  let index = 0;
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i]!.startSec <= time) {
      index = i;
      break;
    }
  }
  const chunk = chunks[index]!;
  return { index, localSec: Math.min(time - chunk.startSec, chunk.durationSec) };
}

/** Local position inside a piece -> global time. */
export function toGlobal(chunk: TimedChunk, localSec: number): number {
  return chunk.startSec + localSec;
}

/** "MM:SS" or "H:MM:SS" (what the model returns) -> seconds; null when it is not a time. */
export function parseClock(value: string): number | null {
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\.\d+)?$/.exec(value.trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
