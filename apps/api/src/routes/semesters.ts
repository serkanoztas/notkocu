import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { loadActiveSemester } from "../services/semesters";
import { asyncHandler } from "../utils/asyncHandler";

export const semestersRouter = Router();
semestersRouter.use(requireAuth);

semestersRouter.get(
  "/active",
  asyncHandler(async (req, res) => {
    res.json(await loadActiveSemester(req.userId));
  }),
);
