import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { openFile } from "../services/files";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

export const filesRouter = Router();
filesRouter.use(requireAuth);

// Authenticated stream. Someone else's (or a missing/malformed) id is always the same 404.
filesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const file = await openFile(req.userId, req.params.id ?? "");
    if (!file) throw new AppError(404, "Dosya bulunamadı", "NOT_FOUND");
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Length", String(file.length));
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    file.stream.on("error", () => res.destroy());
    file.stream.pipe(res);
  }),
);
