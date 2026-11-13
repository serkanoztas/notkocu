import type {
  ActiveSemesterResponse,
  AuthResponse,
  ConfirmScheduleRequest,
  HealthResponse,
  MeResponse,
  ParseScheduleResponse,
} from "@notkocu/shared";
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
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
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
  } catch {
    throw new ApiError("API'ye ulaşılamıyor");
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
    const code = await res
      .json()
      .then((b: { error?: { code?: string } }) => b?.error?.code)
      .catch(() => undefined);
    throw new ApiError(`Sunucu hatası (${res.status})`, res.status, code);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  baseUrl: BASE_URL,
  health: () => request<HealthResponse>("/api/health", { auth: false }),
  me: () => request<MeResponse>("/api/me"),
  loginWithGoogle: (idToken: string) =>
    request<AuthResponse>("/api/auth/google", { method: "POST", body: { idToken }, auth: false, timeoutMs: 15000 }),
  activeSemester: () => request<ActiveSemesterResponse>("/api/semesters/active"),
  parseSchedule: (image: { uri: string; name: string; type: string }) => {
    const form = new FormData();
    // React Native's FormData accepts a { uri, name, type } descriptor in place of a Blob.
    form.append("image", image as unknown as Blob);
    return request<ParseScheduleResponse>("/api/schedule/parse", { method: "POST", form, timeoutMs: 60000 });
  },
  confirmSchedule: (body: ConfirmScheduleRequest) =>
    request<ActiveSemesterResponse>("/api/schedule/confirm", { method: "POST", body, timeoutMs: 15000 }),
  logout: (refreshToken: string) =>
    request<void>("/api/auth/logout", { method: "POST", body: { refreshToken }, auth: false }),
};
