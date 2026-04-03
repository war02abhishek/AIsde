/**
 * logger.ts — Structured observability logger
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHY STRUCTURED LOGGING?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * console.log("retrieved 5 chunks")        ← unstructured, unsearchable
 * log({ phase: "retrieval", chunks: 5 })   ← structured, queryable, measurable
 *
 * Structured logs let you:
 *   - Calculate average latency per phase
 *   - Track token cost per request
 *   - Find which queries have low retrieval scores
 *   - Detect regressions after code changes
 *   - Feed data into the /eval dashboard
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PRODUCTION EQUIVALENT:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * In production you'd ship these logs to:
 *   - Datadog / New Relic  → dashboards + alerts
 *   - LangSmith            → LLM-specific tracing
 *   - OpenTelemetry        → vendor-neutral tracing standard
 *   - CloudWatch / GCP Logs → cloud-native logging
 *
 * Our logger writes to:
 *   1. console (always) — you see it in terminal
 *   2. in-memory ring buffer (last 500 entries) — served by /eval endpoint
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * LOG ENTRY TYPES (one per pipeline phase):
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * ingest:    { filename, chunks, latencyMs }
 * retrieval: { query, topScore, avgScore, chunksFound, latencyMs }
 * generate:  { question, attempts, latencyMs, promptTokens, completionTokens }
 * critic:    { score, pass, issues, latencyMs }
 * request:   { sessionId, agentMode, totalLatencyMs, totalTokens, estimatedCostUsd }
 */

export type LogPhase = "ingest" | "retrieval" | "generate" | "critic" | "request";

export interface BaseLogEntry {
  phase: LogPhase;
  timestamp: string;   // ISO string
  sessionId?: string;
}

export interface IngestLogEntry extends BaseLogEntry {
  phase: "ingest";
  filename: string;
  chunks: number;
  chunkStrategy: string;  // "fixed-size" | "sentence-aware" — so you can compare
  latencyMs: number;
}

export interface RetrievalLogEntry extends BaseLogEntry {
  phase: "retrieval";
  query: string;
  chunksFound: number;
  topScore: number;    // highest similarity score (best chunk)
  avgScore: number;    // average similarity score across all chunks
  latencyMs: number;
}

export interface GenerateLogEntry extends BaseLogEntry {
  phase: "generate";
  question: string;
  attempts: number;    // how many retries were needed (1 = first try succeeded)
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  // estimatedCostUsd = (promptTokens * 0.00000015) + (completionTokens * 0.0000006)
  // gpt-4o-mini pricing as of 2024
  estimatedCostUsd: number;
}

export interface CriticLogEntry extends BaseLogEntry {
  phase: "critic";
  score: number;       // 1-10 faithfulness score
  pass: boolean;       // score >= 7
  issues: string[];    // specific problems found
  latencyMs: number;
}

export interface RequestLogEntry extends BaseLogEntry {
  phase: "request";
  agentMode: boolean;
  totalLatencyMs: number;
  totalTokens: number;
  estimatedCostUsd: number;
  criticScore?: number;
  retrivalAvgScore?: number;
}

export type LogEntry =
  | IngestLogEntry
  | RetrievalLogEntry
  | GenerateLogEntry
  | CriticLogEntry
  | RequestLogEntry;

// WHY NOT Omit<LogEntry, "timestamp"> directly?
// TypeScript's Omit on a discriminated union strips the discriminant (phase)
// making it impossible to narrow the type inside log().
// Fix: Omit timestamp from each member individually, then re-union them.
// This preserves the discriminated union so TypeScript can narrow by phase.
type LogInput =
  | Omit<IngestLogEntry,    "timestamp">
  | Omit<RetrievalLogEntry, "timestamp">
  | Omit<GenerateLogEntry,  "timestamp">
  | Omit<CriticLogEntry,    "timestamp">
  | Omit<RequestLogEntry,   "timestamp">;

// ── In-memory ring buffer ─────────────────────────────────────────
// Stores last MAX_ENTRIES log entries in memory
// Served by GET /eval for the dashboard
// NOTE: resets on server restart — Phase 6+ would persist to DB
const MAX_ENTRIES = 500;
const logBuffer: LogEntry[] = [];

/**
 * Appends a structured log entry to the buffer and prints to console
 *
 * @param entry - Typed log entry for a specific pipeline phase
 *
 * Example:
 *   log({ phase: "retrieval", query: "What is RAG?",
 *         chunksFound: 5, topScore: 0.91, avgScore: 0.74,
 *         latencyMs: 340, timestamp: "2024-01-15T10:30:00Z" })
 *
 *   Console output:
 *   [retrieval] query="What is RAG?" chunks=5 topScore=0.91 latency=340ms
 */
export function log(entry: LogInput): void {
  const full: LogEntry = { ...entry, timestamp: new Date().toISOString() } as LogEntry;

  // Keep buffer size bounded — remove oldest entry when full
  if (logBuffer.length >= MAX_ENTRIES) logBuffer.shift();
  logBuffer.push(full);

  // Human-readable console output per phase
  switch (full.phase) {
    case "ingest":
      console.log(`[log:ingest] file="${full.filename}" chunks=${full.chunks} strategy=${full.chunkStrategy} latency=${full.latencyMs}ms`);
      break;
    case "retrieval":
      console.log(`[log:retrieval] query="${full.query.slice(0, 50)}" chunks=${full.chunksFound} topScore=${full.topScore.toFixed(2)} avgScore=${full.avgScore.toFixed(2)} latency=${full.latencyMs}ms`);
      break;
    case "generate":
      console.log(`[log:generate] attempts=${full.attempts} tokens=${full.promptTokens}+${full.completionTokens} cost=$${full.estimatedCostUsd.toFixed(5)} latency=${full.latencyMs}ms`);
      break;
    case "critic":
      console.log(`[log:critic] score=${full.score}/10 pass=${full.pass} issues=${full.issues.length} latency=${full.latencyMs}ms`);
      break;
    case "request":
      console.log(`[log:request] agentMode=${full.agentMode} totalLatency=${full.totalLatencyMs}ms totalTokens=${full.totalTokens} cost=$${full.estimatedCostUsd.toFixed(5)}`);
      break;
  }
}

/**
 * Returns all log entries (for /eval endpoint)
 * Optionally filtered by phase
 *
 * @param phase - Optional filter (e.g. "retrieval" to get only retrieval logs)
 * @returns     - Array of matching log entries, newest first
 */
export function getLogs(phase?: LogPhase): LogEntry[] {
  const entries = phase ? logBuffer.filter((e) => e.phase === phase) : logBuffer;
  return [...entries].reverse(); // newest first
}

/**
 * Computes aggregate metrics from the log buffer
 * Used by /eval endpoint to power the dashboard
 *
 * Returns:
 *   avgRetrievalScore  — average top similarity score across all retrievals
 *   avgCriticScore     — average faithfulness score across all critic evaluations
 *   avgLatencyMs       — average total request latency
 *   avgCostUsd         — average cost per request
 *   criticPassRate     — % of critic evaluations that passed (score >= 7)
 *   totalRequests      — total number of requests logged
 *
 * Example:
 *   getMetrics()
 *   → { avgRetrievalScore: 0.74, avgCriticScore: 7.8,
 *       avgLatencyMs: 1840, avgCostUsd: 0.00312,
 *       criticPassRate: 0.85, totalRequests: 47 }
 */
export function getMetrics() {
  const retrievals = logBuffer.filter((e): e is RetrievalLogEntry => e.phase === "retrieval");
  const critics    = logBuffer.filter((e): e is CriticLogEntry    => e.phase === "critic");
  const requests   = logBuffer.filter((e): e is RequestLogEntry   => e.phase === "request");

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  return {
    totalRequests:      requests.length,
    avgRetrievalScore:  avg(retrievals.map((r) => r.topScore)),
    avgCriticScore:     avg(critics.map((c) => c.score)),
    criticPassRate:     critics.length ? critics.filter((c) => c.pass).length / critics.length : 0,
    avgLatencyMs:       avg(requests.map((r) => r.totalLatencyMs)),
    avgCostUsd:         avg(requests.map((r) => r.estimatedCostUsd)),
    // Breakdown by phase for latency analysis
    recentLogs:         getLogs().slice(0, 50),
  };
}
