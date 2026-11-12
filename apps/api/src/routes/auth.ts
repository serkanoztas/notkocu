import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { AuthResponse, PublicUser } from "@notkocu/shared";
import { UserModel } from "../models";
import { verifyGoogleIdToken } from "../services/auth/google";
import { issueTokens, revokeRefreshFamily, rotateRefreshToken } from "../services/auth/tokens";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

export const authRouter = Router();

authRouter.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

export function toPublicUser(u: InstanceType<typeof UserModel>): PublicUser {
  return {
    _id: u._id.toString(),
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl ?? undefined,
    timeZone: u.timeZone,
  };
}

const googleBody = z.object({ idToken: z.string().min(1) });
const refreshBody = z.object({ refreshToken: z.string().min(1) });

authRouter.post("/google", asyncHandler(async (req, res) => {
  const { idToken } = googleBody.parse(req.body);
  const profile = await verifyGoogleIdToken(idToken);

  let user =
    (await UserModel.findOne({ googleId: profile.googleId })) ??
    (await UserModel.findOne({ email: profile.email.toLowerCase() }));
  if (user) {
    user.googleId = profile.googleId;
    user.name = profile.name;
    if (profile.avatarUrl) user.avatarUrl = profile.avatarUrl;
    await user.save();
  } else {
    user = await UserModel.create({
      googleId: profile.googleId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
  }

  const tokens = await issueTokens(user._id.toString());
  const body: AuthResponse = { ...tokens, user: toPublicUser(user) };
  res.json(body);
}));

authRouter.post("/refresh", asyncHandler(async (req, res) => {
  const { refreshToken } = refreshBody.parse(req.body);
  const { userId, accessToken, refreshToken: next } = await rotateRefreshToken(refreshToken);
  const user = await UserModel.findById(userId);
  if (!user) throw new AppError(401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");
  const body: AuthResponse = { accessToken, refreshToken: next, user: toPublicUser(user) };
  res.json(body);
}));

authRouter.post("/logout", asyncHandler(async (req, res) => {
  const { refreshToken } = refreshBody.parse(req.body);
  await revokeRefreshFamily(refreshToken);
  res.status(204).end();
}));
