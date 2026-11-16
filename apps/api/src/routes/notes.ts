import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import type { NoteResponse } from "@notkocu/shared";
import { requireAuth } from "../middleware/requireAuth";
import { NoteItemModel } from "../models";
import { assertWithinLimit, deleteFiles, saveFile } from "../services/files";
import { processImage, sniffImageMime } from "../services/imageProcess";
import { requeue } from "../services/queue";
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

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const DEFAULT_IMAGE_TITLE = "Fotoğraf";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
    cb(new AppError(400, "Desteklenmeyen dosya türü", "UNSUPPORTED_IMAGE_TYPE"));
  },
});

/** Multipart bodies carry a photo; JSON bodies (text notes) pass through untouched. */
const receiveUpload: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) return next();
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      return next(
        err.code === "LIMIT_FILE_SIZE"
          ? new AppError(413, "Fotoğraf en fazla 10 MB olabilir", "IMAGE_TOO_LARGE")
          : new AppError(400, "Geçersiz yükleme", "INVALID_UPLOAD"),
      );
    }
    next(err);
  });
};

// Image processing and Gemini cost money: limit per user, not per IP.
const uploadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId,
  skip: (req) => !req.is("multipart/form-data"),
});

// Multipart has no null, so "inbox" is its own flag; fields arrive as strings.
const imageForm = z.object({
  type: z.literal("image"),
  title: title.optional(),
  courseId: objectIdLike.optional(),
  weekNo: z.coerce.number().int().min(1).max(60).optional(),
  inbox: z.enum(["1", "true"]).optional(),
});

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

type Target = { courseId: string; weekNo: number; sessionId?: string } | null;

async function createImageNote(userId: string, raw: unknown, file: Express.Multer.File | undefined) {
  if (!file) throw new AppError(400, "Fotoğraf gerekli", "IMAGE_REQUIRED");
  const form = imageForm.parse(raw);
  const mime = sniffImageMime(file.buffer);
  if (!mime) throw new AppError(400, "Desteklenmeyen dosya türü", "UNSUPPORTED_IMAGE_TYPE");

  let target: Target;
  if (form.inbox) {
    target = null;
  } else if (form.courseId === undefined) {
    target = await autoAssign(userId, new Date()); // the server clock decides, in the user's time zone
  } else {
    if (form.weekNo === undefined) throw new AppError(400, "weekNo gerekli", "VALIDATION_ERROR");
    await assertManualTarget(userId, form.courseId, form.weekNo);
    target = { courseId: form.courseId, weekNo: form.weekNo };
  }

  const processed = await processImage(file.buffer, mime);
  await assertWithinLimit(userId, processed.main.length + (processed.thumb?.length ?? 0));

  const saved: string[] = [];
  try {
    const fileKey = await saveFile(userId, processed.main, { mime: processed.mime, filename: "image" });
    saved.push(fileKey);
    const thumbKey = processed.thumb
      ? await saveFile(userId, processed.thumb, { mime: "image/jpeg", filename: "thumb" })
      : undefined;
    if (thumbKey) saved.push(thumbKey);

    return await NoteItemModel.create({
      userId,
      courseId: target?.courseId ?? null,
      weekNo: target?.weekNo,
      sessionId: target?.sessionId,
      type: "image",
      title: form.title || DEFAULT_IMAGE_TITLE,
      content: { fileKey, thumbKey, mime: processed.mime, width: processed.width, height: processed.height },
      status: "pending", // the worker picks it up
      source: "app",
    });
  } catch (err) {
    await deleteFiles(userId, saved); // no note, no orphan files
    throw err;
  }
}

notesRouter.post(
  "/",
  uploadLimiter,
  receiveUpload,
  asyncHandler(async (req, res) => {
    const userId = req.userId;

    if (req.is("multipart/form-data")) {
      const note = await createImageNote(userId, req.body, req.file);
      await markWeeksStale(userId, [note]);
      const out: NoteResponse = { note: serializeNote(note.toJSON()) };
      res.status(201).json(out);
      return;
    }

    const body = createBody.parse(req.body);

    let target: Target;
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

    if (body.markdown !== undefined && note.type !== "text") {
      throw new AppError(400, "Bu not tipinde metin düzenlenemez", "NOT_EDITABLE");
    }
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
    const content = note.content as { fileKey?: string; thumbKey?: string } | undefined;
    await note.deleteOne();
    await deleteFiles(req.userId, [content?.fileKey, content?.thumbKey]);
    await markWeeksStale(req.userId, [note]);
    res.status(204).end();
  }),
);

// failed -> pending ("Tekrar dene"); the worker takes it from there.
notesRouter.post(
  "/:id/retry",
  asyncHandler(async (req, res) => {
    const note = await findOwnNote(req.userId, req.params.id);
    if (!(await requeue(req.userId, String(note._id)))) {
      throw new AppError(409, "Yalnızca başarısız notlar yeniden denenebilir", "NOT_FAILED");
    }
    const fresh = await findOwnNote(req.userId, req.params.id);
    const out: NoteResponse = { note: serializeNote(fresh.toJSON()) };
    res.json(out);
  }),
);
