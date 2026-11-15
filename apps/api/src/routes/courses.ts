import { Router } from "express";
import { semesterWeekNo, type CourseDetailResponse, type WeekResponse } from "@notkocu/shared";
import { requireAuth } from "../middleware/requireAuth";
import { CourseModel, NoteItemModel, SemesterModel, SessionModel, UserModel } from "../models";
import { assertId, serializeNote, toObjectId } from "../services/notes";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

export const coursesRouter = Router();
coursesRouter.use(requireAuth);

const json = <T>(value: unknown) => JSON.parse(JSON.stringify(value)) as T;

async function loadOwnCourse(userId: string, id: string | undefined) {
  const course = await CourseModel.findOne({ _id: assertId(id), userId }).lean();
  if (!course) throw new AppError(404, "Ders bulunamadı", "NOT_FOUND");
  const semester = await SemesterModel.findOne({ _id: course.semesterId, userId }).lean();
  if (!semester) throw new AppError(404, "Ders bulunamadı", "NOT_FOUND");
  return { course, semester };
}

coursesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const userId = req.userId;
    const { course, semester } = await loadOwnCourse(userId, req.params.id);
    const [sessions, counts, user] = await Promise.all([
      SessionModel.find({ userId, courseId: course._id }).sort({ day: 1, start: 1 }).lean(),
      NoteItemModel.aggregate<{ _id: number; count: number }>([
        { $match: { userId: toObjectId(userId), courseId: course._id, weekNo: { $ne: null } } },
        { $group: { _id: "$weekNo", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      UserModel.findById(userId).select("timeZone").lean(),
    ]);
    const out: CourseDetailResponse = json({
      course,
      sessions,
      semester: {
        _id: semester._id,
        name: semester.name,
        startDate: semester.startDate,
        weekCount: semester.weekCount,
        weekStatuses: semester.weekStatuses,
      },
      currentWeekNo: semesterWeekNo(
        { startDate: semester.startDate.toISOString(), weekCount: semester.weekCount },
        new Date(),
        user?.timeZone,
      ),
      weekNoteCounts: counts.map((c) => ({ weekNo: c._id, count: c.count })),
    });
    res.json(out);
  }),
);

coursesRouter.get(
  "/:id/weeks/:no",
  asyncHandler(async (req, res) => {
    const userId = req.userId;
    const { course, semester } = await loadOwnCourse(userId, req.params.id);
    const no = Number(req.params.no);
    if (!Number.isInteger(no) || no < 1 || no > semester.weekCount) {
      throw new AppError(400, "Geçersiz hafta", "INVALID_WEEK");
    }
    const notes = await NoteItemModel.find({ userId, courseId: course._id, weekNo: no })
      .sort({ createdAt: 1 })
      .lean();
    const out: WeekResponse = {
      course: json(course),
      weekNo: no,
      notes: notes.map(serializeNote),
      summary: null, // AI summary arrives in stage 5
    };
    res.json(out);
  }),
);
