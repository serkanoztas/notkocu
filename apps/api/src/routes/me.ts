import { Router } from "express";
import type { MeResponse } from "@notkocu/shared";
import { requireAuth } from "../middleware/requireAuth";
import { UserModel } from "../models";
import { deleteUserData } from "../services/account";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { toPublicUser } from "./auth";

export const meRouter = Router();

meRouter.use(requireAuth);

meRouter.get("/", asyncHandler(async (req, res) => {
  const user = await UserModel.findById(req.userId);
  if (!user) throw new AppError(401, "Authentication required", "UNAUTHORIZED");
  const body: MeResponse = { user: toPublicUser(user) };
  res.json(body);
}));

meRouter.delete("/", asyncHandler(async (req, res) => {
  await deleteUserData(req.userId);
  res.status(204).end();
}));
