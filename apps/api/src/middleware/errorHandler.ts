import type { ErrorRequestHandler, RequestHandler } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { env } from "../config/env";
import { AppError } from "../utils/AppError";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`, "NOT_FOUND"));
};

interface Normalized {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function normalize(err: unknown): Normalized {
  if (err instanceof AppError) {
    return { status: err.statusCode, code: err.code, message: err.message };
  }
  if (err instanceof ZodError) {
    return { status: 400, code: "VALIDATION_ERROR", message: "Invalid request", details: err.flatten() };
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message]));
    return { status: 400, code: "VALIDATION_ERROR", message: "Invalid data", details };
  }
  if (err instanceof mongoose.Error.CastError) {
    return { status: 400, code: "INVALID_ID", message: `Invalid value for ${err.path}` };
  }
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000) {
    return { status: 409, code: "DUPLICATE", message: "Duplicate value" };
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === "entity.parse.failed") {
    return { status: 400, code: "INVALID_JSON", message: "Malformed JSON body" };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const n = normalize(err);
  if (n.status >= 500) console.error(err);
  res.status(n.status).json({
    error: {
      code: n.code,
      message: n.message,
      ...(n.details !== undefined ? { details: n.details } : {}),
      ...(env.NODE_ENV !== "production" && n.status >= 500 && err instanceof Error
        ? { stack: err.stack }
        : {}),
    },
  });
};
