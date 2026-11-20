import mongoose from "mongoose";
import { AUDIO_UNPIN_GRACE_DAYS } from "@notkocu/shared";
import { NoteItemModel } from "../models";
import { deleteFiles } from "./files";

// Audio files are kept 30 days (content.audioExpiresAt), then every piece is deleted from GridFS.
// The note, transcript, chapters and summary stay. A pinned recording ("Kalıcı yap") is never swept.

const DAY_MS = 24 * 3600 * 1000;

/**
 * Deletes the audio pieces of every expired, unpinned recording. Safe to run from several workers and
 * to repeat: a note is only touched while it still matches the filter. `extraFilter` is for the check scripts.
 */
export async function sweepExpiredAudio(extraFilter: Record<string, unknown> = {}): Promise<number> {
  const due = {
    ...extraFilter,
    type: "audio",
    // Not while the worker may still be reading the pieces.
    status: { $in: ["ready", "failed", "skipped"] },
    "content.audioDeleted": { $ne: true },
    "content.pinned": { $ne: true },
    "content.audioExpiresAt": { $lt: new Date() },
  };
  const notes = await NoteItemModel.find(due).select("userId content.chunks").lean();
  let deleted = 0;
  for (const note of notes) {
    const chunks = (note.content as { chunks?: { fileKey?: string }[] }).chunks ?? [];
    await deleteFiles(String(note.userId), chunks.map((c) => c.fileKey));
    const res = await NoteItemModel.updateOne(
      { _id: note._id, ...due },
      { $set: { "content.audioDeleted": true }, $unset: { "content.chunks.$[].fileKey": "" } },
    );
    if (res.modifiedCount > 0) deleted += 1;
  }
  return deleted;
}

/**
 * "Kalıcı yap" on/off. Un-pinning never deletes at once: the audio gets at least
 * AUDIO_UNPIN_GRACE_DAYS more days (or its old deadline, whichever is later).
 */
export function unpinDeadline(oldExpires: Date | undefined, now = new Date()): Date {
  const grace = now.getTime() + AUDIO_UNPIN_GRACE_DAYS * DAY_MS;
  return new Date(Math.max(grace, oldExpires ? +oldExpires : 0));
}

/** Bytes of recordings the user kept with "Kalıcı yap" (still stored). */
export async function pinnedAudioBytes(userId: string): Promise<number> {
  const [row] = await NoteItemModel.aggregate<{ total: number }>([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        type: "audio",
        "content.pinned": true,
        "content.audioDeleted": { $ne: true },
      },
    },
    { $unwind: "$content.chunks" },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$content.chunks.size", 0] } } } },
  ]);
  return row?.total ?? 0;
}
