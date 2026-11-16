import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import type { NoteResponse } from "@notkocu/shared";
import { requireAuth } from "../middleware/requireAuth";
import { NoteItemModel } from "../models";
import { assertWithinLimit, deleteFiles, saveFile } from "../services/files";
import { sniffDocument } from "../services/documents/sniff";
import { DOCUMENT_MIME } from "../services/documents/types";
import { processImage, sniffImageMime } from "../services/imageProcess";
import { requeue } from "../services/queue";
import { enqueueSuggest } from "../services/suggestQueue";
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

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // documents; photos are capped lower after sniffing
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_IMAGE_TITLE = "Fotoğraf";

// The declared mime is not trusted anywhere: the real type is read from the bytes (sniff*).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/** Multipart bodies carry a photo; JSON bodies (text notes) pass through untouched. */
const receiveUpload: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) return next();
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      return next(
        err.code === "LIMIT_FILE_SIZE"
          ? new AppError(413, "Dosya en fazla 20 MB olabilir", "FILE_TOO_LARGE")
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

// Sent by the app's outbox with every note. clientId makes a retried request idempotent; capturedAt is when
// the note was really taken (the target is decided by that moment, not by the time it reaches the server).
const metaFields = {
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(),
  source: z.enum(["app", "share-intent"]).optional(),
};

// Multipart has no null, so "inbox" is its own flag; fields arrive as strings.
const uploadForm = z.object({
  ...metaFields,
  type: z.enum(["image", "document"]),
  title: title.optional(),
  courseId: objectIdLike.optional(),
  weekNo: z.coerce.number().int().min(1).max(60).optional(),
  inbox: z.enum(["1", "true"]).optional(),
});

const targetFields = {
  ...metaFields,
  courseId: objectIdLike.nullable().optional(),
  weekNo: z.number().int().min(1).max(60).optional(),
};

const createBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), title: title.optional(), markdown, ...targetFields }),
  z.object({
    type: z.literal("link"),
    title: title.optional(),
    url: z
      .string()
      .trim()
      .max(2048)
      .refine((u) => {
        try {
          const { protocol } = new URL(u);
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      }, "Geçersiz bağlantı"),
    ...targetFields,
  }),
]);

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

/** Explicit inbox / manual course+week / (nothing given) the shared auto-assignment rule. */
async function resolveTarget(
  userId: string,
  want: { courseId?: string | null; weekNo?: number },
  when: Date,
): Promise<Target> {
  if (want.courseId === undefined) return autoAssign(userId, when); // by the moment the note was taken, in the user's time zone
  if (want.courseId === null) return null; // explicit inbox
  if (want.weekNo === undefined) throw new AppError(400, "weekNo gerekli", "VALIDATION_ERROR");
  await assertManualTarget(userId, want.courseId, want.weekNo);
  return { courseId: want.courseId, weekNo: want.weekNo };
}

type Meta = { clientId?: string; capturedAt?: string; source?: "app" | "share-intent" };

/** Moment the note was taken (never in the future) and the fields every created note carries. */
function metaOf(m: Meta) {
  const now = new Date();
  let captured = m.capturedAt ? new Date(m.capturedAt) : undefined;
  if (captured && (Number.isNaN(+captured) || +captured > +now)) captured = now;
  return {
    when: captured ?? now,
    stamp: {
      clientId: m.clientId,
      source: m.source ?? "app",
      ...(captured ? { capturedAt: captured, createdAt: captured } : {}),
    },
  };
}

const isDuplicateKey = (err: unknown) => (err as { code?: number } | null)?.code === 11000;

const placement = (target: Target) => ({
  courseId: target?.courseId ?? null,
  weekNo: target?.weekNo,
  sessionId: target?.sessionId,
});

/** multer decodes the multipart filename as latin1; recover UTF-8 names (Turkish letters) when that happened. */
function cleanFileName(raw: string): string {
  let name = raw;
  if ([...raw].every((c) => c.charCodeAt(0) <= 0xff)) {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    if (!decoded.includes("\uFFFD")) name = decoded;
  }
  return name.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 120) || "belge";
}

/** The note this clientId already created, if any: the request is a retry. */
const existingNote = (userId: string, clientId?: string) =>
  clientId ? NoteItemModel.findOne({ userId, clientId }) : Promise.resolve(null);

async function createUploadNote(userId: string, raw: unknown, file: Express.Multer.File | undefined) {
  if (!file) throw new AppError(400, "Dosya gerekli", "FILE_REQUIRED");
  const form = uploadForm.parse(raw);
  const known = await existingNote(userId, form.clientId); // before any processing or storage
  if (known) return { note: known, created: false };

  const { when, stamp } = metaOf(form);
  const target = await resolveTarget(userId, { courseId: form.inbox ? null : form.courseId, weekNo: form.weekNo }, when);
  try {
    const note =
      form.type === "image"
        ? await createImageNote(userId, form, target, file, stamp)
        : await createDocumentNote(userId, form, target, file, stamp);
    return { note, created: true };
  } catch (err) {
    // Two requests with the same clientId raced: the files of ours are already removed, return the winner.
    const winner = isDuplicateKey(err) ? await existingNote(userId, form.clientId) : null;
    if (winner) return { note: winner, created: false };
    throw err;
  }
}

async function createImageNote(
  userId: string,
  form: z.infer<typeof uploadForm>,
  target: Target,
  file: Express.Multer.File,
  stamp: ReturnType<typeof metaOf>["stamp"],
) {
  const mime = sniffImageMime(file.buffer);
  if (!mime) throw new AppError(400, "Desteklenmeyen dosya türü", "UNSUPPORTED_IMAGE_TYPE");
  if (file.buffer.length > MAX_IMAGE_BYTES) throw new AppError(413, "Fotoğraf en fazla 10 MB olabilir", "IMAGE_TOO_LARGE");

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
      ...placement(target),
      type: "image",
      title: form.title || DEFAULT_IMAGE_TITLE,
      content: { fileKey, thumbKey, mime: processed.mime, width: processed.width, height: processed.height },
      status: "pending", // the worker picks it up
      ...stamp,
    });
  } catch (err) {
    await deleteFiles(userId, saved); // no note, no orphan files
    throw err;
  }
}

async function createDocumentNote(
  userId: string,
  form: z.infer<typeof uploadForm>,
  target: Target,
  file: Express.Multer.File,
  stamp: ReturnType<typeof metaOf>["stamp"],
) {
  const kind = sniffDocument(file.buffer);
  if (!kind) throw new AppError(400, "Yalnızca PDF, DOCX ve PPTX desteklenir", "UNSUPPORTED_DOCUMENT_TYPE");
  await assertWithinLimit(userId, file.buffer.length);

  const fileName = cleanFileName(file.originalname);
  const mime = DOCUMENT_MIME[kind];
  const fileKey = await saveFile(userId, file.buffer, { mime, filename: fileName });
  try {
    return await NoteItemModel.create({
      userId,
      ...placement(target),
      type: "document",
      title: form.title || fileName.replace(/\.[^.]+$/, "") || "Belge",
      content: { fileKey, mime, fileName, size: file.buffer.length },
      status: "pending", // the worker extracts the text
      ...stamp,
    });
  } catch (err) {
    await deleteFiles(userId, [fileKey]);
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
      const { note, created } = await createUploadNote(userId, req.body, req.file);
      if (created) await markWeeksStale(userId, [note]);
      const out: NoteResponse = { note: serializeNote(note.toJSON()) };
      res.status(created ? 201 : 200).json(out);
      return;
    }

    const body = createBody.parse(req.body);
    const known = await existingNote(userId, body.clientId);
    if (known) {
      const out: NoteResponse = { note: serializeNote(known.toJSON()) };
      res.status(200).json(out);
      return;
    }
    const { when, stamp } = metaOf(body);
    const target = await resolveTarget(userId, body, when);

    let note;
    try {
      note =
        body.type === "text"
          ? await NoteItemModel.create({
              userId,
              ...placement(target),
              type: "text",
              title: body.title || titleFromMarkdown(body.markdown),
              content: { markdown: body.markdown },
              extractedText: body.markdown,
              status: "ready", // text needs no processing
              ...stamp,
            })
          : await NoteItemModel.create({
              userId,
              ...placement(target),
              type: "link",
              title: body.title || new URL(body.url).hostname,
              content: { url: body.url, siteTitle: body.title || undefined },
              extractedText: [body.title, body.url].filter(Boolean).join("\n"),
              status: "ready", // only url + title are kept, nothing to process
              ...stamp,
            });
    } catch (err) {
      const winner = isDuplicateKey(err) ? await existingNote(userId, body.clientId) : null;
      if (!winner) throw err;
      const out: NoteResponse = { note: serializeNote(winner.toJSON()) };
      res.status(200).json(out);
      return;
    }
    await markWeeksStale(userId, [note]);
    await enqueueSuggest(note._id); // text and links in the inbox get a course suggestion right away
    const fresh = await NoteItemModel.findById(note._id);
    const out: NoteResponse = { note: serializeNote((fresh ?? note).toJSON()) };
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
      note.set("suggestion", undefined); // the old suggestion was for the old text
      note.set("suggestJob", undefined);
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
      note.set("suggestion", undefined); // a hand-picked course replaces any AI suggestion
    }

    await note.save();
    await markWeeksStale(userId, [before, note]);
    if (note.courseId === null) await enqueueSuggest(note._id); // back in the inbox (undo / edit): suggest again if none is kept
    const fresh = await NoteItemModel.findById(note._id);
    const out: NoteResponse = { note: serializeNote((fresh ?? note).toJSON()) };
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
