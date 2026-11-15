import { Router } from "express";
import type { InboxResponse } from "@notkocu/shared";
import { requireAuth } from "../middleware/requireAuth";
import { NoteItemModel } from "../models";
import { serializeNote } from "../services/notes";
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
