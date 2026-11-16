import sharp from "sharp";

const MAX_EDGE = 2000;
const THUMB_EDGE = 200;

export interface ProcessedImage {
  main: Buffer;
  mime: string;
  thumb?: Buffer;
  width?: number;
  height?: number;
}

/** Detects the real image type from the first bytes; the client-declared mime is not trusted. */
export function sniffImageMime(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("ascii", 4, 8) === "ftyp") {
    const brand = b.toString("ascii", 8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  return null;
}

/**
 * Rotates by EXIF, caps the long edge at 2000 px, re-encodes as JPEG (~80) and makes a ~200 px thumbnail.
 * When sharp cannot decode the input (typically HEIC), the original is kept and there is no thumbnail.
 */
export async function processImage(input: Buffer, mime: string): Promise<ProcessedImage> {
  try {
    const { data, info } = await sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const thumb = await sharp(data)
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside" })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { main: data, mime: "image/jpeg", thumb, width: info.width, height: info.height };
  } catch {
    return { main: input, mime };
  }
}
