/** Gemini quota / rate limit (429): the queue waits instead of burning an attempt. */
export class QuotaError extends Error {
  constructor() {
    super("AI quota exceeded");
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
  return new OcrError(`AI_${e.status ?? "UNAVAILABLE"}`);
}
