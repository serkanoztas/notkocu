/** Gemini quota / rate limit (429): the queue waits instead of burning an attempt. */
export class QuotaError extends Error {
  /** "quota" = 429; "unavailable" = 500/503 (model overloaded) even after the fallback model. */
  constructor(public readonly reason: "quota" | "unavailable" = "quota") {
    super(reason === "quota" ? "AI quota exceeded" : "AI temporarily unavailable");
    this.name = "QuotaError";
  }
}

/** Provider, output or input problems: a normal failed attempt. `code` is safe to store and log. */
export class OcrError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "OcrError";
  }
}

/**
 * Maps a failed Gemini request to QuotaError / OcrError. Logs only the HTTP status,
 * never the request, the response or the key.
 */
export function toAiError(err: unknown, what: string): QuotaError | OcrError {
  const e = err as { status?: number; message?: string };
  console.error(`Gemini ${what} request failed (status ${e.status ?? "unknown"})`);
  if (e.status === 429 || /RESOURCE_EXHAUSTED/i.test(e.message ?? "")) return new QuotaError();
  if (e.status === 500 || e.status === 503) return new QuotaError("unavailable");
  return new OcrError(`AI_${e.status ?? "UNAVAILABLE"}`);
}
