import { model, Schema } from "mongoose";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const sessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true },
  // 0 = Monday ... 6 = Sunday. Convert only via @notkocu/shared (dayCodeToIndex, dayIndex).
  day: { type: Number, required: true, min: 0, max: 6 },
  start: { type: String, required: true, match: HHMM },
  end: { type: String, required: true, match: HHMM },
  room: String,
  kind: { type: String, enum: ["teori", "lab", "uygulama"], required: true, default: "teori" },
});

// Auto-assignment: sessions of a user on a given day.
sessionSchema.index({ userId: 1, day: 1 });
// Course page: sessions of a course.
sessionSchema.index({ courseId: 1 });

export const SessionModel = model("Session", sessionSchema);
