import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { env } from "../../config/env";

// All Gemini calls live under services/ai. Never log the API key, image bytes or raw responses.
let client: GoogleGenAI | undefined;

/** Test hook: the check scripts install a fake so that no real Gemini request is made by default. */
let override: GoogleGenAI | undefined;
export function setGeminiOverride(fake: unknown): void {
  override = fake as GoogleGenAI | undefined;
}

export function getGemini(): GoogleGenAI {
  if (override) return override;
  client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return client;
}

export type GeminiTask = "default" | "ocr" | "schedule" | "audio";

/** Per-task model; empty task-specific env falls back to GEMINI_MODEL. */
export function geminiModel(task: GeminiTask = "default"): string {
  if (task === "ocr") return env.GEMINI_MODEL_OCR || env.GEMINI_MODEL;
  if (task === "schedule") return env.GEMINI_MODEL_SCHEDULE || env.GEMINI_MODEL;
  if (task === "audio") return env.GEMINI_MODEL_AUDIO || env.GEMINI_MODEL;
  return env.GEMINI_MODEL;
}

// Models that reject thinkingLevel MINIMAL (Gemini thinking docs): gemini-3.8-flash and Gemini 4.
const NO_MINIMAL = /^(gemini-3.8-flash|gemini-4)/;

/** thinkingConfig for a model, or undefined (setting skipped) when the model does not support the level. */
export function geminiThinkingConfig(model: string) {
  const level = env.GEMINI_THINKING_LEVEL;
  if (level === "MINIMAL" && NO_MINIMAL.test(model)) return undefined;
  return { thinkingLevel: ThinkingLevel[level] };
}

type GenerateParams = Parameters<GoogleGenAI["models"]["generateContent"]>[0];

/**
 * generateContent with a one-shot fallback model: a 500/503 from the primary model is retried at once
 * with GEMINI_FALLBACK_MODEL. If that fails too, its error is thrown and the queue rules take over.
 * Logs only model names and the status, never content.
 */
export async function generateContent(params: GenerateParams) {
  const ai = getGemini();
  try {
    return await ai.models.generateContent(params);
  } catch (err) {
    const status = (err as { status?: number }).status;
    const fallback = env.GEMINI_FALLBACK_MODEL;
    if ((status !== 500 && status !== 503) || !fallback || fallback === params.model) throw err;
    console.warn(`Gemini ${params.model} failed (status ${status}), retrying with fallback ${fallback}`);
    const res = await ai.models.generateContent({
      ...params,
      model: fallback,
      config: { ...params.config, thinkingConfig: geminiThinkingConfig(fallback) },
    });
    console.warn(`Gemini fallback ${fallback} succeeded`);
    return res;
  }
}

/** Model + thinkingConfig for one task, to use in generateContent. */
export function geminiTask(task: GeminiTask = "default") {
  const model = geminiModel(task);
  return { model, thinkingConfig: geminiThinkingConfig(model) };
}
