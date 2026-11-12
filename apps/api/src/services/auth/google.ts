import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env";
import { AppError } from "../../utils/AppError";

const client = new OAuth2Client();

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_WEB_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || !p.email_verified) throw new Error("incomplete payload");
    return {
      googleId: p.sub,
      email: p.email,
      name: p.name?.trim() || p.email.split("@")[0] || p.email,
      avatarUrl: p.picture,
    };
  } catch {
    throw new AppError(401, "Invalid Google token", "INVALID_GOOGLE_TOKEN");
  }
}
