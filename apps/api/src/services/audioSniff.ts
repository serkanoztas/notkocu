// The declared mime is never trusted: the audio type comes from the first bytes.
// Recordings are raw ADTS AAC (.aac, Android) or MP4/M4A (.m4a); both are what Gemini accepts as AAC.
// Imported files may also be Ogg (WhatsApp .opus), MP3, WAV or FLAC (all in Gemini's supported list).

export interface SniffedAudio {
  mime: string;
  ext: string;
}

/** Recording pieces made by the app: ADTS AAC or MP4/M4A only. */
export function sniffAudio(buf: Buffer): SniffedAudio | null {
  if (buf.length < 12) return null;
  // ADTS frame header: 12 sync bits (0xFFF), layer 00.
  if (buf[0] === 0xff && ((buf[1] ?? 0) & 0xf6) === 0xf0) return { mime: "audio/aac", ext: "aac" };
  // ISO base media file: size(4) + "ftyp"
  if (buf.toString("latin1", 4, 8) === "ftyp") return { mime: "audio/mp4", ext: "m4a" };
  return null;
}

/** AMR (".amr", old phone voice notes): not in Gemini's supported list, so it gets its own message. */
export function isAmr(buf: Buffer): boolean {
  return buf.toString("latin1", 0, 5) === "#!AMR";
}

/** Imported files: the recording formats plus Ogg (Vorbis/Opus), MP3, WAV and FLAC. */
export function sniffImportedAudio(buf: Buffer): SniffedAudio | null {
  if (buf.length < 12) return null;
  const head4 = buf.toString("latin1", 0, 4);
  if (head4 === "OggS") return { mime: "audio/ogg", ext: "ogg" }; // WhatsApp .opus is Opus in Ogg
  if (head4 === "fLaC") return { mime: "audio/flac", ext: "flac" };
  if (head4 === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE") return { mime: "audio/wav", ext: "wav" };
  if (buf.toString("latin1", 0, 3) === "ID3") return { mime: "audio/mpeg", ext: "mp3" };
  // MPEG audio frame sync (11 bits) with a layer that is not 00 (00 would be ADTS AAC, checked below).
  if (buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0 && ((buf[1] ?? 0) & 0x06) !== 0) {
    return { mime: "audio/mpeg", ext: "mp3" };
  }
  return sniffAudio(buf);
}

/** Rough length from the size, for a piece the app could not time (24 kbps CBR). */
export function estimateDurationSec(bytes: number): number {
  return Math.max(1, Math.round((bytes * 8) / 24_000));
}
