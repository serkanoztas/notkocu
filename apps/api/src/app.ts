import cors from "cors";
import express from "express";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { authRouter } from "./routes/auth";
import { coursesRouter } from "./routes/courses";
import { healthRouter } from "./routes/health";
import { inboxRouter } from "./routes/inbox";
import { meRouter } from "./routes/me";
import { notesRouter } from "./routes/notes";
import { scheduleRouter } from "./routes/schedule";
import { semestersRouter } from "./routes/semesters";
import { todayRouter } from "./routes/today";

export function createApp() {
  const app = express();
  app.use(cors());

  // Dev-only request log: method, path, status, duration. Never bodies, headers or query strings.
  if (process.env.NODE_ENV !== "production") {
    app.use((req, res, next) => {
      const start = Date.now();
      const path = req.originalUrl.split("?")[0];
      console.log(`→ ${req.method} ${path}`);
      res.on("close", () => {
        const aborted = !res.writableFinished ? " (connection closed before response)" : "";
        console.log(`← ${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms${aborted}`);
      });
      next();
    });
  }

  app.use(express.json({ limit: "1mb" }));

  // Public: health and auth. Every other router must be mounted behind requireAuth.
  app.use("/api/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/me", meRouter);
  app.use("/api/schedule", scheduleRouter);
  app.use("/api/semesters", semestersRouter);
  app.use("/api/today", todayRouter);
  app.use("/api/courses", coursesRouter);
  app.use("/api/notes", notesRouter);
  app.use("/api/inbox", inboxRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
