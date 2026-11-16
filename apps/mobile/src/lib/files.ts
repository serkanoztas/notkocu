import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { api, authHeaders } from "./api";

const safeName = (name: string) => name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 100) || "belge";

/** Downloads a private file with the Authorization header into the cache folder. */
async function downloadAuthed(fileId: string, fileName: string): Promise<File> {
  const dest = new File(Paths.cache, safeName(fileName));
  const run = async () =>
    File.downloadFileAsync(api.fileUrl(fileId), dest, { headers: await authHeaders(), idempotent: true });
  try {
    return await run();
  } catch {
    // The access token lives 15 minutes: any authenticated call refreshes it, then try once more.
    await api.me();
    return run();
  }
}

/** Downloads the original document and hands it to the system share / "open with" sheet. */
export async function openDocument(doc: { fileKey: string; fileName?: string; mime: string }): Promise<void> {
  const file = await downloadAuthed(doc.fileKey, doc.fileName ?? "belge");
  if (!(await Sharing.isAvailableAsync())) throw new Error("SHARING_UNAVAILABLE");
  await Sharing.shareAsync(file.uri, { mimeType: doc.mime, dialogTitle: doc.fileName ?? "Belge" });
}
