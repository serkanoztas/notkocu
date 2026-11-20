import { FileState } from "@google/genai";
import { OcrError } from "./errors";
import { getGemini } from "./gemini";

// Gemini Files API: upload once, reference by uri, delete when done. Used for big PDFs and imported audio.
// Never log bytes or uris.

export interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
}

/** Uploads and waits until the file is ACTIVE (audio needs a moment of server-side processing). */
export async function uploadToFilesApi(bytes: Uint8Array, mimeType: string, maxWaitSec = 30): Promise<UploadedFile> {
  const ai = getGemini();
  let file = await ai.files.upload({ file: new Blob([Buffer.from(bytes)], { type: mimeType }), config: { mimeType } });
  for (let i = 0; i < maxWaitSec && file.state === FileState.PROCESSING; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    file = await ai.files.get({ name: file.name! });
  }
  if (!file.name || !file.uri || file.state === FileState.FAILED || file.state === FileState.PROCESSING) {
    throw new OcrError("AI_FILE_UPLOAD");
  }
  return { name: file.name, uri: file.uri, mimeType };
}

/** The file when it still exists and is usable (a retry may reuse the upload), else null. */
export async function getUsableFile(known: UploadedFile): Promise<UploadedFile | null> {
  try {
    const file = await getGemini().files.get({ name: known.name });
    return file.state === FileState.ACTIVE && file.uri ? { name: known.name, uri: file.uri, mimeType: known.mimeType } : null;
  } catch {
    return null;
  }
}

export async function deleteFromFilesApi(name: string): Promise<void> {
  await getGemini().files.delete({ name }).catch(() => undefined); // best effort; the provider also expires files itself
}
