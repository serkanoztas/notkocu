import {
  CourseModel,
  NoteItemModel,
  RefreshTokenModel,
  SemesterModel,
  SessionModel,
  UserModel,
  WeekSummaryModel,
} from "../models";

/** Deletes the user and everything they own. Idempotent; the user document goes last. */
export async function deleteUserData(userId: string): Promise<void> {
  await RefreshTokenModel.deleteMany({ userId });
  await NoteItemModel.deleteMany({ userId });
  await WeekSummaryModel.deleteMany({ userId });
  await SessionModel.deleteMany({ userId });
  await CourseModel.deleteMany({ userId });
  await SemesterModel.deleteMany({ userId });
  await UserModel.deleteOne({ _id: userId });
}
