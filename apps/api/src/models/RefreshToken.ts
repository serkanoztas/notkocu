import { model, Schema } from "mongoose";

// Opaque refresh tokens are never stored raw: only their SHA-256 hash.
// A token is single-use (usedAt); tokens of one login chain share a familyId
// so reuse of a spent token can revoke the whole chain.
const refreshTokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  tokenHash: { type: String, required: true, unique: true },
  familyId: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ userId: 1 });

export const RefreshTokenModel = model("RefreshToken", refreshTokenSchema);
