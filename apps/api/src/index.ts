import { createApp } from "./app";
import { connectDbInBackground, disconnectDb } from "./config/db";
import { env } from "./config/env";
import "./models";

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`API listening on http://${env.HOST}:${env.PORT}`);
});

// Server stays up even if MongoDB is unreachable; health reports db: "disconnected".
connectDbInBackground();

async function shutdown() {
  server.close();
  await disconnectDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
