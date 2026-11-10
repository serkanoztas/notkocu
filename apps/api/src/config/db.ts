import mongoose from "mongoose";
import { env } from "./env";

const MIN_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

let retryTimer: NodeJS.Timeout | undefined;
let stopped = false;

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

async function attempt(delayMs: number): Promise<void> {
  if (stopped) return;
  try {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
    console.log("MongoDB connected");
  } catch (err) {
    console.error(`MongoDB connection failed, retrying in ${delayMs / 1000}s:`, (err as Error).message);
    retryTimer = setTimeout(() => void attempt(Math.min(delayMs * 2, MAX_DELAY_MS)), delayMs);
  }
}

/**
 * Starts connecting in the background; never throws and never exits the process.
 * After the first successful connection the driver reconnects on its own;
 * this loop only covers the initial connection.
 */
export function connectDbInBackground(): void {
  mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));
  mongoose.connection.on("reconnected", () => console.log("MongoDB reconnected"));
  void attempt(MIN_DELAY_MS);
}

export async function disconnectDb(): Promise<void> {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  await mongoose.disconnect();
}
