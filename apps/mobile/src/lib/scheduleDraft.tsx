import type { ScheduleCourseDraft } from "@notkocu/shared";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { nearestMonday, todayIso } from "./dates";

/** Same palette as the API (routes/schedule.ts), assigned by course order. */
export const COURSE_COLORS = ["#6366F1", "#EC4899", "#14B8A6", "#F59E0B", "#8B5CF6", "#10B981", "#F97316", "#0EA5E9"];

export interface DraftCourse extends ScheduleCourseDraft {
  /** Local key only; not sent to the API. */
  id: string;
}

interface Draft {
  name: string;
  /** "YYYY-MM-DD", always a Monday once the form is valid. */
  startDate: string;
  weekCount: number;
  courses: DraftCourse[];
}

interface DraftValue extends Draft {
  setSemester: (patch: Partial<Pick<Draft, "name" | "startDate" | "weekCount">>) => void;
  setCourses: (courses: ScheduleCourseDraft[]) => void;
  updateCourse: (id: string, course: DraftCourse) => void;
  addCourse: (course: ScheduleCourseDraft) => void;
  removeCourse: (id: string) => void;
}

const DraftContext = createContext<DraftValue | null>(null);

let seq = 0;
const withId = (c: ScheduleCourseDraft): DraftCourse => ({ ...c, id: `c${++seq}` });

function defaultName(): string {
  const now = new Date();
  const year = now.getFullYear();
  // Autumn semester starts in September; before that the current academic term is spring.
  return now.getMonth() >= 8 ? `${year} Güz` : `${year} Bahar`;
}

export function ScheduleDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft>(() => ({
    name: defaultName(),
    startDate: nearestMonday(todayIso()),
    weekCount: 14,
    courses: [],
  }));

  const setSemester = useCallback<DraftValue["setSemester"]>((patch) => setDraft((d) => ({ ...d, ...patch })), []);
  const setCourses = useCallback((courses: ScheduleCourseDraft[]) => {
    setDraft((d) => ({ ...d, courses: courses.map(withId) }));
  }, []);
  const updateCourse = useCallback((id: string, course: DraftCourse) => {
    setDraft((d) => ({ ...d, courses: d.courses.map((c) => (c.id === id ? course : c)) }));
  }, []);
  const addCourse = useCallback((course: ScheduleCourseDraft) => {
    setDraft((d) => ({ ...d, courses: [...d.courses, withId(course)] }));
  }, []);
  const removeCourse = useCallback((id: string) => {
    setDraft((d) => ({ ...d, courses: d.courses.filter((c) => c.id !== id) }));
  }, []);

  const value = useMemo(
    () => ({ ...draft, setSemester, setCourses, updateCourse, addCourse, removeCourse }),
    [draft, setSemester, setCourses, updateCourse, addCourse, removeCourse],
  );
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useScheduleDraft(): DraftValue {
  const ctx = useContext(DraftContext);
  if (!ctx) throw new Error("useScheduleDraft must be used inside ScheduleDraftProvider");
  return ctx;
}
