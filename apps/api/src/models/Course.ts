import { model, Schema } from "mongoose";

const courseSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  semesterId: { type: Schema.Types.ObjectId, ref: "Semester", required: true },
  code: { type: String, required: true, trim: true },
  name: { type: String, default: "", trim: true },
  instructor: { type: String, trim: true },
  color: String,
});

courseSchema.index({ userId: 1, semesterId: 1 });

export const CourseModel = model("Course", courseSchema);
