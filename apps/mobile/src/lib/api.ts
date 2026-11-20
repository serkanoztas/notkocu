import type {
  ActiveSemesterResponse,
  ApproveSuggestionsResponse,
  AuthResponse,
  ConfirmScheduleRequest,
  CourseDetailResponse,
  CreateNoteRequest,
  HealthResponse,
  InboxResponse,
  MeResponse,
  NoteResponse,
  ParseScheduleResponse,
  StorageUsageResponse,
  TodayResponse,
  UpdateNoteRequest,
  WeekResponse,
} from "@notkocu/shared";
import { File } from "expo-file-system";
import { tokenStore } from "./tokenStore";

const BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

let onAuthLost: (() => void) | null = null;
/** AuthProvider registers this; called when the session can no longer be refreshed. */
export function setAuthLostHandler(handler: (() => void) | null) {
  onAuthLost = handler;
}

interface Options {
  method?: string;
  body?: unknown;
  /** Multipart body; fetch sets the Content-Type boundary itself. */
  form?: FormData;
  /** Send the access token and refresh once on 401. Default true. */
  auth?: boolean;
  timeoutMs?: number;
}

async function send(path: string, opts: Options, accessToken: string | null): Promise<Response> {
  if (!BASE_URL) throw new ApiError("EXPO_PUBLIC_API_URL tanımlı değil");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? 5000);
  try {
    return await fetch(`${BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body !== undefined && !opts.form ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      signal: controller.signal,
    });
  } catch (err) {
    if (__DEV__) console.warn(`[api] ${opts.method ?? "GET"} ${path} failed (timedOut=${timedOut}):`, err);
    if (timedOut) throw new ApiError("İstek zaman aşımına uğradı", undefined, "TIMEOUT");
    // fetch failed while building the request (e.g. "Unsupported FormDataPart implementation"): nothing left the device.
    if (opts.form && err instanceof Error && /Unsupported FormData/i.test(err.message)) {
      throw new ApiError("Görsel gönderilemedi", undefined, "CLIENT_REQUEST");
    }
    throw new ApiError("Ağ hatası: sunucuya bağlanılamadı", undefined, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

// Concurrent 401s share a single refresh call (refresh tokens are single-use).
let refreshing: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    const refreshToken = tokenStore.getRefresh();
    if (!refreshToken) return false;
    const res = await send("/api/auth/refresh", { method: "POST", body: { refreshToken }, auth: false }, null);
    if (res.status === 401) return false; // server rejected it: session is over
    if (!res.ok) throw new ApiError(`Sunucu hatası (${res.status})`, res.status);
    const data = (await res.json()) as AuthResponse;
    await tokenStore.set(data);
    await tokenStore.setUser(data.user);
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function request<T>(path: string, opts: Options = {}): Promise<T> {
  const useAuth = opts.auth !== false;
  if (useAuth) await tokenStore.hydrate();

  let res = await send(path, opts, useAuth ? tokenStore.getAccess() : null);
  if (res.status === 401 && useAuth) {
    // Network errors during refresh propagate without signing out.
    if (await refreshSession()) {
      res = await send(path, opts, tokenStore.getAccess());
    }
    if (res.status === 401) {
      await tokenStore.clear();
      onAuthLost?.();
      throw new ApiError("Oturum süresi doldu", 401);
    }
  }
  if (!res.ok) {
    if (__DEV__ && res.status >= 500) console.warn(`[api] ${opts.method ?? "GET"} ${path} -> ${res.status}`);
    const code = await res
      .json()
      .then((b: { error?: { code?: string } }) => b?.error?.code)
      .catch(() => undefined);
    throw new ApiError(`Sunucu hatası (${res.status})`, res.status, code);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Where a new file note (photo or document) goes: omitted = server auto-assigns; courseId null = inbox. */
export interface PhotoTarget {
  courseId?: string | null;
  weekNo?: number;
  /** Imported audio: which session of the course (needed when the course has several). */
  sessionId?: string;
}

export interface UploadMeta {
  clientId: string;
  capturedAt: string;
  source: "app" | "share-intent" | "import";
}

/** Authorization header for image requests (RN <Image> cannot go through request()). */
export async function authHeaders(): Promise<Record<string, string>> {
  await tokenStore.hydrate();
  const token = tokenStore.getAccess();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const api = {
  baseUrl: BASE_URL,
  fileUrl: (id: string) => `${BASE_URL}/api/files/${id}`,
  health: () => request<HealthResponse>("/api/health", { auth: false }),
  me: () => request<MeResponse>("/api/me"),
  loginWithGoogle: (idToken: string) =>
    request<AuthResponse>("/api/auth/google", { method: "POST", body: { idToken }, auth: false, timeoutMs: 15000 }),
  activeSemester: () => request<ActiveSemesterResponse>("/api/semesters/active"),
  parseSchedule: (image: { uri: string; name: string; type: string }) => {
    const form = new FormData();
    // The global fetch is expo/fetch (SDK 58), which rejects RN's { uri, name, type } descriptor.
    // expo-file-system's File is Blob-like (has bytes(), name, type), so it is accepted as a part.
    // It takes name/type from the file URI; the picker's cache files carry a proper extension.
    form.append("image", new File(image.uri) as unknown as Blob);
    return request<ParseScheduleResponse>("/api/schedule/parse", { method: "POST", form, timeoutMs: 60000 });
  },
  createFileNote: (kind: "image" | "document", fileUri: string, target: PhotoTarget, meta: UploadMeta, title?: string) => {
    const form = new FormData();
    form.append("type", kind);
    form.append("clientId", meta.clientId);
    form.append("capturedAt", meta.capturedAt);
    form.append("source", meta.source);
    if (title) form.append("title", title);
    if (target.courseId === null) form.append("inbox", "1");
    else if (target.courseId) {
      form.append("courseId", target.courseId);
      if (target.weekNo) form.append("weekNo", String(target.weekNo));
    }
    // expo-file-system File as a part (see parseSchedule); name/type come from the picker's cache file.
    form.append("file", new File(fileUri) as unknown as Blob);
    return request<NoteResponse>("/api/notes", { method: "POST", form, timeoutMs: kind === "document" ? 120000 : 60000 });
  },
  /** A recording: its pieces (in order) and each piece's length in seconds. A long upload, hence the long timeout. */
  createAudioNote: (fileUris: string[], durationsSec: number[], target: PhotoTarget, meta: UploadMeta, title?: string) => {
    const form = new FormData();
    form.append("type", "audio");
    form.append("clientId", meta.clientId);
    form.append("capturedAt", meta.capturedAt);
    form.append("source", meta.source);
    form.append("chunkDurations", JSON.stringify(durationsSec));
    if (title) form.append("title", title);
    if (target.courseId === null) form.append("inbox", "1");
    else if (target.courseId) {
      form.append("courseId", target.courseId);
      if (target.weekNo) form.append("weekNo", String(target.weekNo));
    }
    for (const uri of fileUris) form.append("file", new File(uri) as unknown as Blob);
    return request<NoteResponse>("/api/notes", { method: "POST", form, timeoutMs: 600000 });
  },
  /** An external audio file (picked or shared): one file, the server reads its length and dates it by the chosen lesson. */
  importAudioNote: (fileUri: string, target: PhotoTarget, meta: UploadMeta, title?: string) => {
    const form = new FormData();
    form.append("type", "audio");
    form.append("clientId", meta.clientId);
    form.append("capturedAt", meta.capturedAt);
    form.append("source", meta.source);
    if (title) form.append("title", title);
    if (target.courseId === null) form.append("inbox", "1");
    else if (target.courseId) {
      form.append("courseId", target.courseId);
      if (target.weekNo) form.append("weekNo", String(target.weekNo));
      if (target.sessionId) form.append("sessionId", target.sessionId);
    }
    form.append("file", new File(fileUri) as unknown as Blob);
    return request<NoteResponse>("/api/notes?import=1", { method: "POST", form, timeoutMs: 900000 });
  },
  approveSuggestions: (noteIds: string[]) =>
    request<ApproveSuggestionsResponse>("/api/inbox/approve", { method: "POST", body: { noteIds }, timeoutMs: 15000 }),
  retryNote: (id: string) => request<NoteResponse>(`/api/notes/${id}/retry`, { method: "POST", timeoutMs: 15000 }),
  storage: () => request<StorageUsageResponse>("/api/me/storage"),
  today: () => request<TodayResponse>("/api/today"),
  inbox: () => request<InboxResponse>("/api/inbox"),
  course: (id: string) => request<CourseDetailResponse>(`/api/courses/${id}`),
  week: (id: string, weekNo: number) => request<WeekResponse>(`/api/courses/${id}/weeks/${weekNo}`),
  /** Queues a new summary for the week even if the old one is not stale. */
  refreshWeekSummary: (id: string, weekNo: number) =>
    request<{ summary: WeekResponse["summary"] }>(`/api/courses/${id}/weeks/${weekNo}/summary`, { method: "POST", timeoutMs: 15000 }),
  note: (id: string) => request<NoteResponse>(`/api/notes/${id}`),
  createNote: (body: CreateNoteRequest) =>
    request<NoteResponse>("/api/notes", { method: "POST", body, timeoutMs: 15000 }),
  updateNote: (id: string, body: UpdateNoteRequest) =>
    request<NoteResponse>(`/api/notes/${id}`, { method: "PATCH", body, timeoutMs: 15000 }),
  deleteNote: (id: string) => request<void>(`/api/notes/${id}`, { method: "DELETE", timeoutMs: 15000 }),
  confirmSchedule: (body: ConfirmScheduleRequest) =>
    request<ActiveSemesterResponse>("/api/schedule/confirm", { method: "POST", body, timeoutMs: 15000 }),
  logout: (refreshToken: string) =>
    request<void>("/api/auth/logout", { method: "POST", body: { refreshToken }, auth: false }),
};
