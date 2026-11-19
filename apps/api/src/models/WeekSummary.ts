import { model, Schema } from "mongoose";

// Queue bookkeeping (never sent to clients): "write this week's summary", same rules as the other lanes.
const jobSchema = new Schema(
  {
    state: { type: String, enum: ["pending", "processing", "done", "failed"], default: "done" },
    attempts: { type: Number, default: 0 },
    deferrals: { type: Number, default: 0 },
    runAt: { type: Date, default: () => new Date() },
    leaseUntil: Date,
    lastError: String,
    failedAt: Date,
  },
  { _id: false },
);

const weekSummarySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true },
  weekNo: { type: Number, required: true, min: 1 },
  summary: { type: String, default: "" },
  noteIds: { type: [Schema.Types.ObjectId], ref: "NoteItem", default: [] },
  generatedAt: Date,
  stale: { type: Boolean, default: true },
  job: { type: jobSchema, default: () => ({}) },
});

weekSummarySchema.index({ userId: 1, courseId: 1, weekNo: 1 }, { unique: true });
weekSummarySchema.index({ "job.state": 1, "job.runAt": 1 });

export const WeekSummaryModel = model("WeekSummary", weekSummarySchema);
