import { Readable } from "node:stream";
import mongoose from "mongoose";
import { env } from "../config/env";
import { AppError } from "../utils/AppError";
import { assertId } from "./notes";

// Files live in MongoDB GridFS (bucket "files"). Every file carries metadata.userId and every
// read, usage count and delete is filtered by it: one user can never reach another user's file.

const BUCKET = "files";
const toId = (id: string) => new mongoose.mongo.ObjectId(assertId(id));

function db() {
  const d = mongoose.connection.db;
  if (!d) throw new AppError(503, "Veritabanı hazır değil", "DB_UNAVAILABLE");
  return d;
}
const bucket = () => new mongoose.mongo.GridFSBucket(db(), { bucketName: BUCKET });
const filesCollection = () => db().collection(`${BUCKET}.files`);

let indexReady = false;
async function ensureIndex() {
  if (indexReady) return;
  await filesCollection().createIndex({ "metadata.userId": 1 });
  indexReady = true;
}

export const storageLimitBytes = () => Math.round(env.USER_STORAGE_LIMIT_MB * 1024 * 1024);

/** Total bytes of the user's files (images and thumbnails). */
export async function getUsage(userId: string): Promise<number> {
  await ensureIndex();
  const [row] = await filesCollection()
    .aggregate<{ total: number }>([
      { $match: { "metadata.userId": userId } },
      { $group: { _id: null, total: { $sum: "$length" } } },
    ])
    .toArray();
  return row?.total ?? 0;
}

/** Soft limit: two simultaneous uploads can overshoot it slightly. */
export async function assertWithinLimit(userId: string, extraBytes: number): Promise<void> {
  if ((await getUsage(userId)) + extraBytes > storageLimitBytes()) {
    throw new AppError(413, "Depolama alanın doldu", "STORAGE_LIMIT");
  }
}

/** Writes the buffer to GridFS and returns the file id (string). */
export async function saveFile(userId: string, data: Buffer, opts: { mime: string; filename: string }): Promise<string> {
  await ensureIndex();
  const upload = bucket().openUploadStream(opts.filename, { metadata: { userId, mime: opts.mime } });
  await new Promise<void>((resolve, reject) => {
    upload.once("finish", () => resolve());
    upload.once("error", reject);
    Readable.from(data).pipe(upload);
  });
  return String(upload.id);
}

async function findOwn(userId: string, id: string) {
  const [file] = await bucket().find({ _id: toId(id), "metadata.userId": userId }).limit(1).toArray();
  return file ?? null;
}

/** Stream + metadata for the user's own file; null when it does not exist or belongs to someone else. */
export async function openFile(userId: string, id: string) {
  const file = await findOwn(userId, id);
  if (!file) return null;
  return {
    stream: bucket().openDownloadStream(file._id),
    mime: String((file.metadata as { mime?: string } | undefined)?.mime ?? "application/octet-stream"),
    length: file.length,
  };
}

export async function readFile(userId: string, id: string): Promise<{ data: Buffer; mime: string } | null> {
  const opened = await openFile(userId, id);
  if (!opened) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
  return { data: Buffer.concat(chunks), mime: opened.mime };
}

/** Deletes the user's own files; ignores missing ones and foreign ids. */
export async function deleteFiles(userId: string, ids: (string | undefined | null)[]): Promise<void> {
  for (const id of ids) {
    if (!id) continue;
    try {
      const file = await findOwn(userId, id);
      if (file) await bucket().delete(file._id);
    } catch (err) {
      console.error("File delete failed:", (err as Error).message);
    }
  }
}

export async function deleteUserFiles(userId: string): Promise<void> {
  await ensureIndex();
  const files = await bucket().find({ "metadata.userId": userId }).project({ _id: 1 }).toArray();
  for (const f of files) await bucket().delete(f._id);
}
