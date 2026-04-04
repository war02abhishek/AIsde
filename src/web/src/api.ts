/**
 * api.ts — Typed fetch wrappers for the backend API
 *
 * WHY A SEPARATE FILE?
 * Keeps all HTTP logic in one place. Components just call chatApi() or ingestApi()
 * without knowing about fetch, headers, or error handling.
 *
 * PROXY:
 * Vite proxies /chat, /ingest, /health, /eval, /ingest-url to http://localhost:3000
 * (configured in vite.config.ts) so we don't need to hardcode the backend URL.
 */

// ── Shared types ──────────────────────────────────────────────────

export interface Citation {
  source: string;
  chunk: string;
  score?: number;
}

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  followUpQuestions: string[];
  sessionId: string;
}

export interface IngestResponse {
  success: boolean;
  chunksStored: number;
  filename: string;
}

// Phase 6: URL ingest response — includes title and source server info
export interface UrlIngestResponse {
  success: boolean;
  chunksStored: number;
  filename: string;
  title?: string;
  url: string;
  source?: string; // "mcp-server-fetch" or "url_fetch-fallback"
}

// ── Phase 5: Eval types ───────────────────────────────────────────

export interface EvalMetrics {
  totalRequests: number;
  avgRetrievalScore: number;  // avg top similarity score across all retrievals
  avgCriticScore: number;     // avg faithfulness score (agent mode only)
  criticPassRate: number;     // % of critic evals that passed (>= 7)
  avgLatencyMs: number;       // avg total request latency
  avgCostUsd: number;         // avg cost per request
  recentLogs: any[];          // last 50 structured log entries
}

export interface EvalResult {
  id: string;
  question: string;
  retrievalRecall: number;  // 1.0 = correct chunk retrieved, 0.0 = not found
  answerRelevance: number;  // 1.0 = expected keywords in answer, 0.0 = missing
  latencyMs: number;
  answer: string;
  topChunkScore: number;
}

export interface EvalSummary {
  avgRetrievalRecall: number;
  avgAnswerRelevance: number;
  avgLatencyMs: number;
  avgTopChunkScore: number;
  results: EvalResult[];
  ranAt: string;
}

// ── API functions ─────────────────────────────────────────────────

/**
 * POST /chat — sends a message, returns answer + citations + follow-ups
 *
 * @param message    - User's question
 * @param sessionId  - Optional session ID for memory continuity
 * @param agentMode  - true = multi-agent graph, false = baseline pipeline
 */
export async function chatApi(
  message: string,
  sessionId?: string,
  agentMode = false
): Promise<ChatResponse> {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId, agentMode }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Chat request failed");
  }
  return res.json();
}

/**
 * POST /ingest — chunks, embeds, and stores a document in Chroma
 *
 * @param content  - Full document text
 * @param filename - Document name (used as ID in Chroma)
 * @param metadata - Optional key-value pairs stored alongside chunks
 */
export async function ingestApi(
  content: string,
  filename: string,
  metadata?: Record<string, string>
): Promise<IngestResponse> {
  const res = await fetch("/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, filename, metadata }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Ingest request failed");
  }
  return res.json();
}

/**
 * POST /ingest-url — fetches a URL and ingests it into Chroma via MCP tool chaining
 * One call does: fetch URL → strip HTML → chunk → embed → store
 *
 * @param url       - URL to fetch and ingest (must be http/https)
 * @param filename  - Optional custom document name (derived from URL if omitted)
 * @param metadata  - Optional key-value metadata stored alongside chunks
 * @param fetchMode - "python" = use mcp-server-fetch | "node" = use our url_fetch (default)
 */
export async function ingestUrlApi(
  url: string,
  filename?: string,
  metadata?: Record<string, string>,
  fetchMode: "python" | "node" = "node"
): Promise<UrlIngestResponse> {
  const res = await fetch("/ingest-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, filename, metadata, fetchMode }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "URL ingest failed");
  }
  return res.json();
}

/**
 * GET /eval — returns live metrics aggregated from the log buffer
 * Free and instant — reads from in-memory logs, no API calls
 */
export async function getEvalMetrics(): Promise<EvalMetrics> {
  const res = await fetch("/eval");
  if (!res.ok) throw new Error("Failed to fetch eval metrics");
  return res.json();
}

/**
 * POST /eval — runs the full eval dataset through the pipeline
 * WARNING: costs ~8 OpenAI API calls and takes ~30-60 seconds
 * Returns per-question scores + aggregate metrics
 */
export async function runEvalDataset(): Promise<EvalSummary> {
  const res = await fetch("/eval", { method: "POST" });
  if (!res.ok) throw new Error("Eval run failed");
  return res.json();
}
