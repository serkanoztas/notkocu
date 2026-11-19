import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  GOOGLE_WEB_CLIENT_ID: z.string().min(1, "GOOGLE_WEB_CLIENT_ID is required"),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  // No default on purpose: check the current model names in the Gemini docs.
  GEMINI_MODEL: z.string().min(1, "GEMINI_MODEL is required"),
  // Optional per-task overrides; empty falls back to GEMINI_MODEL.
  GEMINI_MODEL_OCR: z.string().optional(),
  GEMINI_MODEL_SCHEDULE: z.string().optional(),
  GEMINI_MODEL_AUDIO: z.string().optional(),
  // Tried once, immediately, when a call gets 500/503; empty = no fallback.
  GEMINI_FALLBACK_MODEL: z.string().optional(),
  // MINIMAL is skipped automatically for models that do not support it.
  // Per-user file storage cap (GridFS), in MB.
  USER_STORAGE_LIMIT_MB: z.coerce.number().positive().default(200),
  GEMINI_THINKING_LEVEL: z.enum(["MINIMAL", "LOW"]).default("MINIMAL"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
