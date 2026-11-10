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
  fileKey: string;
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

export interface HealthResponse {
  status: "ok";
  db: "connected" | "disconnected";
  time: ISODate;
}
