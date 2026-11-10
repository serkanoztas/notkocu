import { model, Schema } from "mongoose";

const weekSummarySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true },
  weekNo: { type: Number, required: true, min: 1 },
  summary: { type: String, default: "" },
  noteIds: { type: [Schema.Types.ObjectId], ref: "NoteItem", default: [] },
  generatedAt: Date,
  stale: { type: Boolean, default: true },
});

weekSummarySchema.index({ userId: 1, courseId: 1, weekNo: 1 }, { unique: true });

export const WeekSummaryModel = model("WeekSummary", weekSummarySchema);
