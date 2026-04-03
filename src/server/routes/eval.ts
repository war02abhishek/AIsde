/**
 * eval.ts — GET /eval and POST /eval routes
 *
 * GET /eval  → returns live metrics from the log buffer
 *              (aggregated from all requests since server start)
 *
 * POST /eval → runs the full eval dataset through the pipeline
 *              returns per-question scores + aggregate metrics
 *              WARNING: costs ~8 OpenAI API calls (one per eval case)
 *
 * EXAMPLE GET /eval response:
 *   {
 *     "totalRequests": 12,
 *     "avgRetrievalScore": 0.74,
 *     "avgCriticScore": 7.8,
 *     "criticPassRate": 0.85,
 *     "avgLatencyMs": 1840,
 *     "avgCostUsd": 0.00312,
 *     "recentLogs": [...]
 *   }
 *
 * EXAMPLE POST /eval response:
 *   {
 *     "avgRetrievalRecall": 0.875,
 *     "avgAnswerRelevance": 0.750,
 *     "avgLatencyMs": 1240,
 *     "avgTopChunkScore": 0.82,
 *     "results": [...],
 *     "ranAt": "2024-01-15T10:30:00Z"
 *   }
 */

import { Router, Request, Response } from "express";
import { getMetrics } from "../../lib/observability/logger";
import { runEval } from "../../lib/eval/metrics";

const router = Router();

// GET /eval — live metrics from log buffer (free, instant)
router.get("/", (_req: Request, res: Response) => {
  const metrics = getMetrics();
  res.json(metrics);
});

// POST /eval — run full eval dataset (costs API calls, takes ~30s)
router.post("/", async (_req: Request, res: Response) => {
  try {
    console.log("[eval route] Starting full eval run...");
    const summary = await runEval();
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Eval failed" });
  }
});

export default router;
