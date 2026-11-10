import { model, Schema } from "mongoose";
import { DEFAULT_TIME_ZONE } from "@notkocu/shared";

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    avatarUrl: String,
    // IANA zone; day/time/week calculations use this, not the server clock.
    timeZone: { type: String, required: true, default: DEFAULT_TIME_ZONE },
    pushTokens: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const UserModel = model("User", userSchema);
