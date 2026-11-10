import { model, Schema } from "mongoose";

const suggestionSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true },
    weekNo: { type: Number, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false },
);

const noteItemSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Unassigned (inbox) notes always have an explicit null courseId.
    courseId: { type: Schema.Types.ObjectId, ref: "Course", default: null },
    weekNo: Number,
    sessionId: { type: Schema.Types.ObjectId, ref: "Session" },
    type: {
      type: String,
      enum: ["text", "document", "image", "audio", "link", "task", "code"],
      required: true,
    },
    title: { type: String, default: "", trim: true },
    // Type-specific fields (see docs/teknik-plan.md); validated per type in the notes service.
    content: { type: Schema.Types.Mixed, default: {} },
    extractedText: String,
    aiSummary: String,
    suggestion: suggestionSchema,
    status: {
      type: String,
      enum: ["pending", "processing", "ready", "failed"],
      default: "pending",
    },
    source: { type: String, enum: ["app", "share-intent"], default: "app" },
    tags: { type: [String], default: [] },
  },
  { timestamps: true },
);

// Week page, and inbox (courseId: null) via the same index.
noteItemSchema.index({ userId: 1, courseId: 1, weekNo: 1, createdAt: -1 });
noteItemSchema.index({ userId: 1, courseId: 1, createdAt: -1 });

export const NoteItemModel = model("NoteItem", noteItemSchema);
