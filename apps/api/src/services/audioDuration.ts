import { parseBuffer } from "music-metadata";

/**
 * Length of an imported file in seconds, read from the file itself (pure JS, no ffmpeg).
 * Order: the container's duration; else size / bit rate; else null (the caller answers 400 UNREADABLE_AUDIO).
 */
export async function readAudioDuration(data: Buffer, mime: string): Promise<number | null> {
  try {
    const meta = await parseBuffer(new Uint8Array(data), { mimeType: mime }, { duration: true, skipCovers: true });
    const duration = meta.format.duration;
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) return duration;
    const bitrate = meta.format.bitrate;
    if (typeof bitrate === "number" && bitrate > 0) return Math.max(1, (data.length * 8) / bitrate);
  } catch {
    // unreadable container: fall through
  }
  return null;
}
