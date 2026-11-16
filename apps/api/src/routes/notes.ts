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

// Multipart has no null, so "inbox" is its own flag; fields arrive as strings.
const uploadForm = z.object({
  type: z.enum(["image", "document"]),
  title: title.optional(),
  courseId: objectIdLike.optional(),
  weekNo: z.coerce.number().int().min(1).max(60).optional(),
  inbox: z.enum(["1", "true"]).optional(),
});

const targetFields = {
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
): Promise<Target> {
  if (want.courseId === undefined) return autoAssign(userId, new Date()); // the server clock decides, in the user's time zone
  if (want.courseId === null) return null; // explicit inbox
  if (want.weekNo === undefined) throw new AppError(400, "weekNo gerekli", "VALIDATION_ERROR");
  await assertManualTarget(userId, want.courseId, want.weekNo);
  return { courseId: want.courseId, weekNo: want.weekNo };
}

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

async function createUploadNote(userId: string, raw: unknown, file: Express.Multer.File | undefined) {
  if (!file) throw new AppError(400, "Dosya gerekli", "FILE_REQUIRED");
  const form = uploadForm.parse(raw);
  const target = await resolveTarget(userId, { courseId: form.inbox ? null : form.courseId, weekNo: form.weekNo });
  return form.type === "image"
    ? createImageNote(userId, form, target, file)
    : createDocumentNote(userId, form, target, file);
}

async function createImageNote(
  userId: string,
  form: z.infer<typeof uploadForm>,
  target: Target,
  file: Express.Multer.File,
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
      source: "app",
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
      source: "app",
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
      const note = await createUploadNote(userId, req.body, req.file);
      await markWeeksStale(userId, [note]);
      const out: NoteResponse = { note: serializeNote(note.toJSON()) };
      res.status(201).json(out);
      return;
    }

    const body = createBody.parse(req.body);
    const target = await resolveTarget(userId, body);

    const note =
      body.type === "text"
        ? await NoteItemModel.create({
            userId,
            ...placement(target),
            type: "text",
            title: body.title || titleFromMarkdown(body.markdown),
            content: { markdown: body.markdown },
            extractedText: body.markdown,
            status: "ready", // text needs no processing
            source: "app",
          })
        : await NoteItemModel.create({
            userId,
            ...placement(target),
            type: "link",
            title: body.title || new URL(body.url).hostname,
            content: { url: body.url, siteTitle: body.title || undefined },
            extractedText: [body.title, body.url].filter(Boolean).join("\n"),
            status: "ready", // only url + title are kept, nothing to process
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
