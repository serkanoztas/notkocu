import type { HealthResponse } from "@notkocu/shared";

const BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, timeoutMs = 5000): Promise<T> {
  if (!BASE_URL) throw new ApiError("EXPO_PUBLIC_API_URL tanımlı değil");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { signal: controller.signal });
    if (!res.ok) throw new ApiError(`Sunucu hatası (${res.status})`, res.status);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("API'ye ulaşılamıyor");
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  baseUrl: BASE_URL,
  health: () => request<HealthResponse>("/api/health"),
};