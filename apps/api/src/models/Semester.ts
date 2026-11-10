import { model, Schema } from "mongoose";

const weekStatusSchema = new Schema(
  {
    weekNo: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ["normal", "holiday", "midterm", "final"], required: true },
  },
  { _id: false },
);

const semesterSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true, trim: true },
  startDate: { type: Date, required: true },
  weekCount: { type: Number, required: true, default: 14, min: 1 },
  weekStatuses: { type: [weekStatusSchema], default: [] },
  isActive: { type: Boolean, default: false },
});

semesterSchema.index({ userId: 1, isActive: 1 });

export const SemesterModel = model("Semester", semesterSchema);
