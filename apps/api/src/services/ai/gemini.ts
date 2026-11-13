import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env";

// All Gemini calls live under services/ai. Never log the API key, image bytes or raw responses.
let client: GoogleGenAI | undefined;

export function getGemini(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return client;
}

export const geminiModel = (): string => env.GEMINI_MODEL;
