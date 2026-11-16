import { Router } from "express";
import { z } from "zod";
import type { ApproveSuggestionsResponse, InboxResponse } from "@notkocu/shared";
import { requireAuth } from "../middleware/requireAuth";
import { NoteItemModel } from "../models";
import { assertId, assertManualTarget, markWeeksStale, serializeNote } from "../services/notes";
import { asyncHandler } from "../utils/asyncHandler";

export const inboxRouter = Router();
inboxRouter.use(requireAuth);

inboxRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // Unassigned notes always have an explicit null courseId (see the NoteItem index).
    const filter = { userId: req.userId, courseId: null };
    const [notes, count] = await Promise.all([
      NoteItemModel.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
      NoteItemModel.countDocuments(filter),
    ]);
    const out: InboxResponse = { notes: notes.map(serializeNote), count };
    res.json(out);
  }),
);

const approveBody = z.object({ noteIds: z.array(z.string().min(1).max(40)).min(1).max(50) });

// Assigns inbox notes to the course + week the AI suggested. The suggestion stays on the note, so
// "Geri al" (PATCH courseId: null) brings the card back with its suggestion.
inboxRouter.post(
  "/approve",
  asyncHandler(async (req, res) => {
    const { noteIds } = approveBody.parse(req.body);
    const userId = req.userId;
    const approved: string[] = [];
    const skipped: string[] = [];

    for (const raw of new Set(noteIds)) {
      let id: string;
      try {
        id = assertId(raw);
      } catch {
        skipped.push(raw);
        continue;
      }
      const note = await NoteItemModel.findOne({ _id: id, userId, courseId: null, suggestion: { $exists: true } });
      if (!note?.suggestion) {
        skipped.push(id);
        continue;
      }
      try {
        // The course or the week may have vanished since the suggestion was made.
        await assertManualTarget(userId, String(note.suggestion.courseId), note.suggestion.weekNo);
      } catch {
        skipped.push(id);
        continue;
      }
      note.set({ courseId: note.suggestion.courseId, weekNo: note.suggestion.weekNo });
      note.sessionId = undefined;
      await note.save();
      await markWeeksStale(userId, [note]);
      approved.push(id);
    }
    const out: ApproveSuggestionsResponse = { approved, skipped };
    res.json(out);
  }),
);
