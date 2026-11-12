import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { AuthTokens } from "@notkocu/shared";
import { env } from "../../config/env";
import { RefreshTokenModel } from "../../models";
import { AppError } from "../../utils/AppError";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const unauthorized = () => new AppError(401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");

export function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: userId,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** Returns the user id, or null for an invalid/expired token. */
export function verifyAccessToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
    return typeof payload === "object" && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

async function issueRefreshToken(userId: string, familyId: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await RefreshTokenModel.create({
    userId,
    tokenHash: hash(raw),
    familyId,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return raw;
}

/** New login: starts a new token family. */
export async function issueTokens(userId: string): Promise<AuthTokens> {
  return {
    accessToken: signAccessToken(userId),
    refreshToken: await issueRefreshToken(userId, randomUUID()),
  };
}

/** Single-use rotation. Re-presenting a spent token revokes its whole family. */
export async function rotateRefreshToken(raw: string): Promise<{ userId: string } & AuthTokens> {
  const tokenHash = hash(raw);
  const consumed = await RefreshTokenModel.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: new Date() } },
    { usedAt: new Date() },
  );
  if (!consumed) {
    const spent = await RefreshTokenModel.findOne({ tokenHash });
    if (spent) await RefreshTokenModel.deleteMany({ familyId: spent.familyId });
    throw unauthorized();
  }
  const userId = consumed.userId.toString();
  return {
    userId,
    accessToken: signAccessToken(userId),
    refreshToken: await issueRefreshToken(userId, consumed.familyId),
  };
}

/** Revokes the whole family of the given token. Unknown tokens are ignored. */
export async function revokeRefreshFamily(raw: string): Promise<void> {
  const token = await RefreshTokenModel.findOne({ tokenHash: hash(raw) });
  if (token) await RefreshTokenModel.deleteMany({ familyId: token.familyId });
}
