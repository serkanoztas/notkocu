import { model, Schema } from "mongoose";

// Daily audio-processing budget ledger: seconds of audio a user's recordings have claimed on one LOCAL day
// (day = "YYYY-MM-DD" in the user's time zone). See services/audioBudget.ts.
const audioUsageSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  day: { type: String, required: true },
  seconds: { type: Number, default: 0 },
  createdAt: { type: Date, default: () => new Date() },
});

audioUsageSchema.index({ userId: 1, day: 1 }, { unique: true });

export const AudioUsageModel = model("AudioUsage", audioUsageSchema);
