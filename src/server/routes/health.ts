/**
 * health.ts — GET /health route
 *
 * PURPOSE:
 * Simple liveness check — confirms the server is running.
 * Used by monitoring tools, Docker health checks, and load balancers
 * to verify the service is alive before routing traffic to it.
 *
 * EXAMPLE RESPONSE:
 *   { "status": "ok", "timestamp": "2024-01-15T10:30:00.000Z", "env": "development" }
 */

import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(), // useful for checking if server clock is correct
    env: process.env.NODE_ENV ?? "development",
  });
});

export default router;
