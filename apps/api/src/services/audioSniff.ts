// The declared mime is never trusted: the audio type comes from the first bytes.
// Recordings are raw ADTS AAC (.aac, Android) or MP4/M4A (.m4a); both are what Gemini accepts as AAC.

export interface SniffedAudio {
  mime: string;
  ext: string;
}

export function sniffAudio(buf: Buffer): SniffedAudio | null {
  if (buf.length < 12) return null;
  // ADTS frame header: 12 sync bits (0xFFF), layer 00.
  if (buf[0] === 0xff && ((buf[1] ?? 0) & 0xf6) === 0xf0) return { mime: "audio/aac", ext: "aac" };
  // ISO base media file: size(4) + "ftyp"
  if (buf.toString("latin1", 4, 8) === "ftyp") return { mime: "audio/mp4", ext: "m4a" };
  return null;
}

/** Rough length from the size, for a piece the app could not time (24 kbps CBR). */
export function estimateDurationSec(bytes: number): number {
  return Math.max(1, Math.round((bytes * 8) / 24_000));
}
