import { GoogleGenAI } from "@google/genai";
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

export const geminiModel = (): string => env.GEMINI_MODEL;
export const geminiThinkingLevel = () => env.GEMINI_THINKING_LEVEL;
