import { Router } from "express";
import { dayIndex, semesterWeekNo, sessionState, type TodayResponse, type TodaySessionItem } from "@notkocu/shared";
import { requireAuth } from "../middleware/requireAuth";
import { NoteItemModel } from "../models";
import { loadActiveContext } from "../services/semesters";
import { asyncHandler } from "../utils/asyncHandler";

export const todayRouter = Router();
todayRouter.use(requireAuth);

const json = <T>(value: unknown) => JSON.parse(JSON.stringify(value)) as T;

todayRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.userId;
    const now = new Date();
    const { timeZone, semester, courses, sessions } = await loadActiveContext(userId);
    const inboxCount = await NoteItemModel.countDocuments({ userId, courseId: null });
    if (!semester) {
      const empty: TodayResponse = { semester: null, weekNo: null, sessions: [], ongoing: null, tasks: [], inboxCount };
      res.json(empty);
      return;
    }

    const weekNo = semesterWeekNo(
      { startDate: semester.startDate.toISOString(), weekCount: semester.weekCount },
      now,
      timeZone,
    );
    const today = dayIndex(now, timeZone);
    const items: TodaySessionItem[] = sessions
      .filter((s) => s.day === today)
      .flatMap((s) => {
        const course = courses.find((c) => c._id.equals(s.courseId));
        const state = sessionState(s, now, timeZone);
        if (!course || !state) return [];
        const ref = { _id: course._id, code: course.code, name: course.name, color: course.color };
        return [json<TodaySessionItem>({ session: s, course: ref, state })];
      });

    const current = items.find((i) => i.state === "ongoing");
    const weekNoteCount =
      current && weekNo
        ? await NoteItemModel.countDocuments({ userId, courseId: current.course._id, weekNo })
        : 0;

    const out: TodayResponse = {
      semester: json({
        _id: semester._id,
        name: semester.name,
        startDate: semester.startDate,
        weekCount: semester.weekCount,
      }),
      weekNo,
      sessions: items,
      ongoing: current ? { ...current, weekNoteCount } : null,
      tasks: [], // no task notes until a later stage
      inboxCount,
    };
    res.json(out);
  }),
);
