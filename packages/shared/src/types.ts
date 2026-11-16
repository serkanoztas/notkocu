// Shared types between mobile and API. Dates are ISO strings at the API boundary.
// Session.day: 0 = Monday ... 6 = Sunday (see time.ts for conversions).

export type Id = string;
export type ISODate = string;

export type WeekStatusKind = "normal" | "holiday" | "midterm" | "final";
export type SessionKind = "teori" | "lab" | "uygulama";
export type NoteType = "text" | "document" | "image" | "audio" | "link" | "task" | "code";
export type NoteStatus = "pending" | "processing" | "ready" | "failed";
export type NoteSource = "app" | "share-intent";

export interface User {
  _id: Id;
  email: string;
  name: string;
  avatarUrl?: string;
  /** IANA time zone; all day/time/week calculations use this, never the server clock. */
  timeZone: string;
  pushTokens: string[];
  createdAt: ISODate;
}

export interface WeekStatus {
  weekNo: number;
  status: WeekStatusKind;
}

export interface Semester {
  _id: Id;
  userId: Id;
  name: string;
  startDate: ISODate;
  weekCount: number;
  weekStatuses: WeekStatus[];
  isActive: boolean;
}

export interface Course {
  _id: Id;
  userId: Id;
  semesterId: Id;
  code: string;
  name: string;
  instructor?: string;
  color?: string;
}

export interface Session {
  _id: Id;
  userId: Id;
  courseId: Id;
  /** 0 = Monday ... 6 = Sunday */
  day: number;
  /** "HH:mm" */
  start: string;
  end: string;
  room?: string;
  kind: SessionKind;
}

export interface NoteSuggestion {
  courseId: Id;
  weekNo: number;
  confidence: number;
}

export interface TextContent {
  markdown: string;
}
export interface DocumentContent {
  fileKey: string;
  mime: string;
  pageCount?: number;
  pages?: string[];
}
export interface ImageContent {
  /** GridFS file id of the (processed) image; GET /api/files/:id. */
  fileKey: string;
  /** ~200 px thumbnail; absent when the server could not decode the image (e.g. HEIC). */
  thumbKey?: string;
  mime?: string;
  width?: number;
  height?: number;
  ocrMarkdown?: string;
}
export interface AudioContent {
  fileKey: string;
  durationSec?: number;
  transcript?: { startSec: number; endSec?: number; text: string }[];
  chapters?: { startSec: number; title: string }[];
}
export interface LinkContent {
  url: string;
  siteTitle?: string;
  thumbnail?: string;
}
export interface TaskContent {
  dueAt?: ISODate;
  remindAt?: ISODate;
  done: boolean;
}
export interface CodeContent {
  language: string;
  code: string;
}

export interface NoteContentByType {
  text: TextContent;
  document: DocumentContent;
  image: ImageContent;
  audio: AudioContent;
  link: LinkContent;
  task: TaskContent;
  code: CodeContent;
}

interface NoteItemBase {
  _id: Id;
  userId: Id;
  /** Always explicitly null when unassigned (inbox). */
  courseId: Id | null;
  weekNo?: number;
  sessionId?: Id;
  title: string;
  extractedText?: string;
  aiSummary?: string;
  suggestion?: NoteSuggestion;
  status: NoteStatus;
  source: NoteSource;
  tags: string[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type NoteItem = {
  [T in NoteType]: NoteItemBase & { type: T; content: NoteContentByType[T] };
}[NoteType];

export interface WeekSummary {
  _id: Id;
  userId: Id;
  courseId: Id;
  weekNo: number;
  summary: string;
  noteIds: Id[];
  generatedAt: ISODate;
  stale: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export type PublicUser = Pick<User, "_id" | "email" | "name" | "avatarUrl" | "timeZone">;

export interface AuthResponse extends AuthTokens {
  user: PublicUser;
}

export interface MeResponse {
  user: PublicUser;
}

// --- Schedule import ---

export interface ScheduleTimeSlot {
  day: number;
  start: string;
  end: string;
}

export interface ScheduleSessionDraft extends ScheduleTimeSlot {
  room?: string;
  kind: SessionKind;
  /** Other plausible slots when the time was hard to read. */
  alternatives?: ScheduleTimeSlot[];
}

export interface ScheduleCourseDraft {
  code: string;
  name: string;
  instructor?: string;
  sessions: ScheduleSessionDraft[];
  /** 0..1; < 0.8 is shown as "needs review". */
  confidence: number;
}

export interface ParseScheduleResponse {
  courses: ScheduleCourseDraft[];
}

export interface ConfirmScheduleRequest {
  semester: { name: string; startDate: string; weekCount: number };
  courses: {
    code: string;
    name: string;
    instructor?: string;
    sessions: { day: number; start: string; end: string; room?: string; kind: SessionKind }[];
  }[];
  /** Deactivate the current active semester instead of answering 409. */
  replaceActive?: boolean;
}

export type CourseWithSessions = Course & { sessions: Session[] };

export interface ActiveSemesterResponse {
  semester: Semester | null;
  courses: CourseWithSessions[];
}

export interface StorageUsageResponse {
  usedBytes: number;
  limitBytes: number;
}

export interface HealthResponse {
  status: "ok";
  db: "connected" | "disconnected";
  time: ISODate;
}

// --- Notes, today, courses (stage 3) ---

export type SessionState = "upcoming" | "ongoing" | "done";

export interface CreateNoteRequest {
  type: "text";
  title?: string;
  markdown: string;
  /** Omitted = the server auto-assigns by the current time; null = inbox; an id = manual (weekNo required). */
  courseId?: Id | null;
  weekNo?: number;
}

export interface UpdateNoteRequest {
  title?: string;
  markdown?: string;
  /** null moves the note back to the inbox; an id requires weekNo. */
  courseId?: Id | null;
  weekNo?: number;
}

export interface NoteResponse {
  note: NoteItem;
}

export interface InboxResponse {
  notes: NoteItem[];
  count: number;
}

export type CourseRef = Pick<Course, "_id" | "code" | "name" | "color">;

export interface TodaySessionItem {
  session: Session;
  course: CourseRef;
  state: SessionState;
}

export interface TodayResponse {
  semester: Pick<Semester, "_id" | "name" | "startDate" | "weekCount"> | null;
  /** Current semester week, null outside the semester. */
  weekNo: number | null;
  sessions: TodaySessionItem[];
  /** The session in progress right now, with the course's note count for this week. */
  ongoing: (TodaySessionItem & { weekNoteCount: number }) | null;
  /** Tasks of this week; always empty until the task type exists. */
  tasks: NoteItem[];
  inboxCount: number;
}

export interface CourseDetailResponse {
  course: Course;
  sessions: Session[];
  semester: Pick<Semester, "_id" | "name" | "startDate" | "weekCount" | "weekStatuses">;
  currentWeekNo: number | null;
  weekNoteCounts: { weekNo: number; count: number }[];
}

export interface WeekResponse {
  course: Course;
  weekNo: number;
  notes: NoteItem[];
  /** AI summary; null until stage 5. */
  summary: WeekSummary | null;
}
