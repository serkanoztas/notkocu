import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import multer from "multer";
import { z } from "zod";
import { dayIndex, parseHHmm, type ActiveSemesterResponse, type ParseScheduleResponse } from "@notkocu/shared";
import { requireAuth } from "../middleware/requireAuth";
import { CourseModel, SemesterModel, SessionModel } from "../models";
import { parseScheduleImage } from "../services/ai/scheduleParser";
import { loadActiveSemester } from "../services/semesters";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

export const scheduleRouter = Router();
scheduleRouter.use(requireAuth);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const COURSE_COLORS = ["#6366F1", "#EC4899", "#14B8A6", "#F59E0B", "#8B5CF6", "#10B981", "#F97316", "#0EA5E9"];

const upload = multer({
  storage: multer.memoryStorage(), // the image is never stored, only forwarded to Gemini
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
    cb(new AppError(400, "Desteklenmeyen dosya türü", "UNSUPPORTED_IMAGE_TYPE"));
  },
});

const receiveImage: RequestHandler = (req, res, next) => {
  upload.single("image")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      return next(
        err.code === "LIMIT_FILE_SIZE"
          ? new AppError(413, "Görsel en fazla 8 MB olabilir", "IMAGE_TOO_LARGE")
          : new AppError(400, "Geçersiz yükleme", "INVALID_UPLOAD"),
      );
    }
    next(err);
  });
};

// Gemini costs money: limit per user, not per IP.
const parseLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId,
});

scheduleRouter.post(
  "/parse",
  parseLimiter,
  receiveImage,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "Görsel gerekli", "IMAGE_REQUIRED");
    const body: ParseScheduleResponse = await parseScheduleImage({
      data: req.file.buffer,
      mimeType: req.file.mimetype,
    });
    res.json(body);
  }),
);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const confirmBody = z.object({
  semester: z.object({
    name: z.string().trim().min(1).max(60),
    // Calendar date, must be a Monday (weeks run Mon-Sun from startDate).
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => {
        const d = new Date(`${s}T12:00:00Z`);
        return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
      }, "Geçersiz tarih")
      .refine((s) => dayIndex(new Date(`${s}T12:00:00Z`), "UTC") === 0, "Başlangıç Pazartesi olmalı"),
    weekCount: z.number().int().min(1).max(30),
  }),
  courses: z
    .array(
      z.object({
        code: z.string().trim().max(20).default(""),
        name: z.string().trim().min(1).max(120),
        instructor: z.string().trim().max(120).optional(),
        sessions: z
          .array(
            z
              .object({
                day: z.number().int().min(0).max(6),
                start: hhmm,
                end: hhmm,
                room: z.string().trim().max(40).optional(),
                kind: z.enum(["teori", "lab", "uygulama"]),
              })
              .refine((s) => parseHHmm(s.end) > parseHHmm(s.start), "Bitiş başlangıçtan sonra olmalı"),
          )
          .min(1)
          .max(20),
      }),
    )
    .min(1)
    .max(30),
  replaceActive: z.boolean().optional(),
});

scheduleRouter.post(
  "/confirm",
  asyncHandler(async (req, res) => {
    const { semester, courses, replaceActive } = confirmBody.parse(req.body);
    const userId = req.userId;

    const dbSession = await mongoose.startSession();
    try {
      // Needs a replica set (Atlas is one); a standalone local mongod can't run transactions.
      await dbSession.withTransaction(async () => {
        const active = await SemesterModel.findOne({ userId, isActive: true }).session(dbSession);
        if (active && !replaceActive) {
          throw new AppError(409, "Aktif bir dönem zaten var", "ACTIVE_SEMESTER_EXISTS");
        }
        if (active) {
          await SemesterModel.updateMany({ userId, isActive: true }, { isActive: false }, { session: dbSession });
        }

        const [created] = await SemesterModel.create(
          [
            {
              userId,
              name: semester.name,
              // Noon UTC keeps the same calendar day in every user time zone.
              startDate: new Date(`${semester.startDate}T12:00:00Z`),
              weekCount: semester.weekCount,
              isActive: true,
            },
          ],
          { session: dbSession },
        );
        if (!created) throw new Error("Semester was not created");

        const courseDocs = await CourseModel.insertMany(
          courses.map((c, i) => ({
            userId,
            semesterId: created._id,
            code: c.code,
            name: c.name,
            instructor: c.instructor || undefined,
            color: COURSE_COLORS[i % COURSE_COLORS.length],
          })),
          { session: dbSession },
        );
        await SessionModel.insertMany(
          courses.flatMap((c, i) =>
            c.sessions.map((s) => ({
              userId,
              courseId: courseDocs[i]!._id,
              day: s.day,
              start: s.start,
              end: s.end,
              room: s.room || undefined,
              kind: s.kind,
            })),
          ),
          { session: dbSession },
        );
      });
    } finally {
      await dbSession.endSession();
    }

    const body: ActiveSemesterResponse = await loadActiveSemester(userId);
    res.status(201).json(body);
  }),
);
