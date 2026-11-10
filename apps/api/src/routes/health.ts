import { Router } from "express";
import type { HealthResponse } from "@notkocu/shared";
import { isDbConnected } from "../config/db";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  const body: HealthResponse = {
    status: "ok",
    db: isDbConnected() ? "connected" : "disconnected",
    time: new Date().toISOString(),
  };
  res.json(body);
});
