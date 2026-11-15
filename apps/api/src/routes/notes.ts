import { Router } from "express";
import { z } from "zod";
import type { NoteResponse } from "@notkocu/shared";
import { requireAuth } from "../middleware/requireAuth";
import { NoteItemModel } from "../models";
import {
  assertId,
  assertManualTarget,
  autoAssign,
  markWeeksStale,
  serializeNote,
  titleFromMarkdown,
} from "../services/notes";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

export const notesRouter = Router();
notesRouter.use(requireAuth);

const MAX_MARKDOWN = 20_000;
const markdown = z.string().trim().min(1).max(MAX_MARKDOWN);
const title = z.string().trim().max(120);
const objectIdLike = z.string().min(1).max(40);

const createBody = z.object({
  type: z.literal("text"),
  title: title.optional(),
  markdown,
  courseId: objectIdLike.nullable().optional(),
  weekNo: z.number().int().min(1).max(60).optional(),
});

const updateBody = z
  .object({
    title: title.optional(),
    markdown: markdown.optional(),
    courseId: objectIdLike.nullable().optional(),
    weekNo: z.number().int().min(1).max(60).optional(),
  })
  .refine((b) => typeof b.courseId !== "string" || b.weekNo !== undefined, {
    message: "weekNo is required when courseId is set",
    path: ["weekNo"],
  });

async function findOwnNote(userId: string, id: string | undefined) {
  const note = await NoteItemModel.findOne({ _id: assertId(id), userId });
  if (!note) throw new AppError(404, "Not bulunamadı", "NOT_FOUND");
  return note;
}

notesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createBody.parse(req.body);
    const userId = req.userId;

    let target: { courseId: string; weekNo: number; sessionId?: string } | null;
    if (body.courseId === undefined) {
      target = await autoAssign(userId, new Date()); // the server clock decides, in the user's time zone
    } else if (body.courseId === null) {
      target = null; // explicit inbox
    } else {
      if (body.weekNo === undefined) throw new AppError(400, "weekNo gerekli", "VALIDATION_ERROR");
      await assertManualTarget(userId, body.courseId, body.weekNo);
      target = { courseId: body.courseId, weekNo: body.weekNo };
    }

    const note = await NoteItemModel.create({
      userId,
      courseId: target?.courseId ?? null,
      weekNo: target?.weekNo,
      sessionId: target?.sessionId,
      type: "text",
      title: body.title || titleFromMarkdown(body.markdown),
      content: { markdown: body.markdown },
      extractedText: body.markdown,
      status: "ready", // text needs no processing
      source: "app",
    });
    await markWeeksStale(userId, [note]);
    const out: NoteResponse = { note: serializeNote(note.toJSON()) };
    res.status(201).json(out);
  }),
);

notesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const note = await findOwnNote(req.userId, req.params.id);
    const out: NoteResponse = { note: serializeNote(note.toJSON()) };
    res.json(out);
  }),
);

notesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = updateBody.parse(req.body);
    const userId = req.userId;
    const note = await findOwnNote(userId, req.params.id);
    const before = { courseId: note.courseId, weekNo: note.weekNo };

    if (body.markdown !== undefined) {
      note.content = { markdown: body.markdown };
      note.extractedText = body.markdown;
    }
    if (body.title !== undefined) {
      note.title = body.title || titleFromMarkdown(body.markdown ?? note.extractedText ?? "");
    }
    if (body.courseId === null) {
      note.courseId = null;
      note.weekNo = undefined;
      note.sessionId = undefined;
    } else if (typeof body.courseId === "string") {
      await assertManualTarget(userId, body.courseId, body.weekNo!);
      note.set({ courseId: body.courseId, weekNo: body.weekNo });
      note.sessionId = undefined; // assigned by hand, not by a session
    }

    await note.save();
    await markWeeksStale(userId, [before, note]);
    const out: NoteResponse = { note: serializeNote(note.toJSON()) };
    res.json(out);
  }),
);

notesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const note = await findOwnNote(req.userId, req.params.id);
    await note.deleteOne();
    await markWeeksStale(req.userId, [note]);
    res.status(204).end();
  }),
);
