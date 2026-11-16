import mongoose from "mongoose";
import { env } from "../config/env";
import { NoteItemModel } from "../models";
import { startWorker } from "./run";

// Separate process: `npm run worker`. Takes pending notes from MongoDB (see services/queue.ts).

const CONCURRENCY = 2;

async function main() {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  await NoteItemModel.syncIndexes();
  const worker = startWorker({ concurrency: CONCURRENCY });
  console.log(`Worker started (concurrency ${CONCURRENCY})`);

  const shutdown = () => {
    void worker.stop().then(async () => {
      await mongoose.disconnect();
      console.log("Worker stopped");
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Worker crashed:", (err as Error).message);
  process.exit(1);
});
