import type { RequestHandler } from "express";
import { verifyAccessToken } from "../services/auth/tokens";
import { AppError } from "../utils/AppError";

declare module "express-serve-static-core" {
  interface Request {
    userId: string;
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const userId = token ? verifyAccessToken(token) : null;
  if (!userId) return next(new AppError(401, "Authentication required", "UNAUTHORIZED"));
  req.userId = userId;
  next();
};
