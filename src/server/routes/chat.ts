/**
 * chat.ts — POST /chat route
 *
 * PHASE 4 CHANGES:
 *   - Added "agentMode" flag to request body
 *   - agentMode=false → Phase 1-3 baseline pipeline (retrieve → generate)
 *   - agentMode=true  → Phase 4 multi-agent graph (orchestrator → retrieval → critic)
 *
 * WHY KEEP BOTH?
 *   This is a key production pattern: feature flags.
 *   You never rip out working code — you run both side by side
 *   and compare quality, latency, and cost before fully switching.
 *
 *   Baseline:   ~2 LLM calls, ~1-2s, cheaper
 *   Agent mode: ~4-6 LLM calls, ~3-5s, more expensive but higher quality
 *
 * PIPELINE (baseline, agentMode=false):
 *   Request → Zod validate
 *     → retrieve()              [Chroma top-k chunks]
 *     → formatMemoryForPrompt() [session history]
 *     → generate()              [LLM + structured output + retry]
 *     → addTurn() + maybeSummarize()
 *     → Response
 *
 * PIPELINE (agent mode, agentMode=true):
 *   Request → Zod validate
 *     → formatMemoryForPrompt() [session history]
 *     → runAgentGraph()         [orchestrator → retrieval → critic loop]
 *     → addTurn() + maybeSummarize()
 *     → Response
 *
 * EXAMPLE REQUEST (agent mode):
 *   POST /chat
 *   { "message": "What is RAG and how does chunking work?",
 *     "sessionId": "abc-123", "agentMode": true }
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { ChatResponseSchema } from "../../lib/schemas/answer";
import { retrieve } from "../../lib/rag/retriever";
import { generate } from "../../lib/rag/generator";
import { addTurn, getSession } from "../../lib/memory/store";
import { maybeSummarize, formatMemoryForPrompt } from "../../lib/memory/summarizer";
import { runAgentGraph } from "../../lib/agents/graph";
import { log, getLogs, CriticLogEntry } from "../../lib/observability/logger";

const router = Router();

// ── Extended request schema for Phase 4 ──────────────────────────
// agentMode is optional — defaults to false (baseline pipeline)
// This is backward compatible: existing clients don't need to change
const ChatRequestSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
  agentMode: z.boolean().optional().default(false),
});


// http://Wanve.abhishek:a%40123456789@10.10.3.124:8080
router.post("/", async (req: Request, res: Response) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { message, sessionId, agentMode } = parsed.data;
  const resolvedSessionId = sessionId ?? randomUUID();
  const requestStart = Date.now();

  console.log(`[chat] agentMode=${agentMode}, session=${resolvedSessionId}`);

  try {
    // Memory is used by BOTH pipelines — always format it first
    const memory = formatMemoryForPrompt(resolvedSessionId);
    console.log(`[chat] Memory length: ${memory.length} chars`);

    let answer: string;
    let citations: any[];
    let followUpQuestions: string[];

    if (agentMode) {
      // ── PHASE 4: Multi-Agent Graph ──────────────────────────────
      // Replaces the 3 lines below with a full orchestrator→retrieval→critic loop
      // The graph handles: query rewriting, parallel retrieval,
      // deduplication, generation, and citation faithfulness checking
      console.log(`[chat] Running agent graph...`);
      const finalState = await runAgentGraph(message, resolvedSessionId, memory);

      answer            = finalState.answer;
      citations         = finalState.citations;
      followUpQuestions = finalState.followUpQuestions;

      console.log(`[chat] Agent graph complete. Critic score: ${finalState.criticScore}/10`);

    } else {
      // ── BASELINE: Phase 1-3 Pipeline (kept for comparison) ─────
      // This is the original linear pipeline from Phase 1-3.
      // Kept intentionally so you can compare:
      //   - Response quality: agent vs baseline
      //   - Latency: agent (~3-5s) vs baseline (~1-2s)
      //   - Cost: agent (4-6 LLM calls) vs baseline (1-2 LLM calls)
      console.log(`[chat] Running baseline pipeline...`);

      // Step 1: Single retrieval (no query rewriting, no dedup)
      const retrieved = await retrieve(message);

      // Step 2: Generate with memory (no critic, no retry)
      const generated = await generate(message, retrieved.context, memory);

      answer            = generated.answer;
      citations         = retrieved.citations;
      followUpQuestions = generated.followUpQuestions;
    }

    // ── Memory update (same for both pipelines) ──────────────────
    addTurn(resolvedSessionId, "user", message);
    addTurn(resolvedSessionId, "assistant", answer);
    await maybeSummarize(resolvedSessionId);

    const session = getSession(resolvedSessionId);
    console.log(`[chat] Session turns: ${session.turns.length}, summary: "${session.summary.slice(0, 60)}..."`);

    // ── Phase 5: Request-level structured log ───────────────────────────
    // Captures full request latency + cost in one entry for the dashboard
    // getLogs("critic") returns LogEntry[] — we cast to CriticLogEntry[]
    // because we filtered by phase="critic", so every entry is guaranteed
    // to be a CriticLogEntry with a score field
    const recentCritic = getLogs("critic")[0] as CriticLogEntry | undefined;
    log({
      phase: "request",
      sessionId: resolvedSessionId,
      agentMode: agentMode ?? false,
      totalLatencyMs: Date.now() - requestStart,
      totalTokens: 0,        // summed from generate logs in future
      estimatedCostUsd: 0,   // summed from generate logs in future
      criticScore: agentMode ? recentCritic?.score : undefined,
    });

    // ── Validate response shape with Zod before sending ──────────
    // This ensures we never send malformed data to the client
    const response = ChatResponseSchema.parse({
      answer,
      citations,
      followUpQuestions,
      sessionId: resolvedSessionId,
    });

    res.json(response);

  } catch (err: any) {
    const status = err?.status ?? 500;
    res.status(status).json({ error: err?.message ?? "Chat failed" });
  }
});

export default router;
