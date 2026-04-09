/**
 * App.tsx — Main UI component
 *
 * LAYOUT:
 *   ┌─────────────────────────────────────────────┐
 *   │  Header: AIsde RAG Chat                     │
 *   ├───────────────────────┬─────────────────────┤
 *   │                       │                     │
 *   │   Chat Panel          │   Citations Panel   │
 *   │   - message bubbles   │   - source chunks   │
 *   │   - follow-up chips   │   - score badges    │
 *   │   - input box         │                     │
 *   ├───────────────────────┴─────────────────────┤
 *   │  Upload Panel (collapsible)                 │
 *   │  - paste document text + filename → ingest  │
 *   └─────────────────────────────────────────────┘
 *
 * STATE:
 *   messages    - chat history shown in the chat panel
 *   citations   - citations from the last assistant response
 *   sessionId   - persisted across turns for memory (Phase 3)
 *   loading     - disables input while waiting for response
 *   uploadOpen  - toggles the upload panel
 *   agentMode   - toggles between baseline RAG and multi-agent graph (Phase 4)
 *
 * PHASE 4 CHANGES:
 *   - Added agentMode state + toggle button
 *   - Agent mode indicator badge in header
 *   - Clear Session button resets memory
 *
 * PHASE 5 CHANGES:
 *   - Added "Eval" tab alongside "Chat" tab
 *   - Eval tab shows:
 *       Live Metrics cards — aggregated from log buffer (GET /eval)
 *       Run Eval button    — triggers full dataset run (POST /eval)
 *       Per-question table — recall, relevance, latency per question
 *
 * TABS:
 *   chat → existing chat UI (Phase 1-4)
 *   eval → Phase 5 metrics dashboard
 */

import { useState, useRef, useEffect } from "react";
import {
  chatApi, ingestApi, Citation,
  getEvalMetrics, runEvalDataset,
  EvalMetrics, EvalSummary,
  ingestUrlApi,
} from "./api";

// Shape of a single chat message in the UI
interface Message {
  role: "user" | "assistant";
  content: string;
  followUpQuestions?: string[];
}

type Tab = "chat" | "eval";

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");

  // ── Chat state ────────────────────────────────────────────────
  const [messages, setMessages]     = useState<Message[]>([]);
  const [citations, setCitations]   = useState<Citation[]>([]);
  const [input, setInput]           = useState("");
  const [sessionId, setSessionId]   = useState<string | undefined>();
  const [loading, setLoading]       = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [agentMode, setAgentMode]   = useState(false);

  // Upload form state
  const [docContent, setDocContent]     = useState("");
  const [docFilename, setDocFilename]   = useState("");
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploading, setUploading]       = useState(false);

  // URL ingest state (Phase 6)
  const [urlInput, setUrlInput]         = useState("");
  const [urlStatus, setUrlStatus]       = useState<string | null>(null);
  const [urlIngesting, setUrlIngesting] = useState(false);
  // fetchMode toggle: "node" = our url_fetch (works on corporate proxy)
  //                   "python" = mcp-server-fetch (better quality, may fail on proxy)
  const [fetchMode, setFetchMode]       = useState<"python" | "node">("node");

  // ── Eval state (Phase 5) ──────────────────────────────────────
  const [liveMetrics, setLiveMetrics]       = useState<EvalMetrics | null>(null);
  const [evalSummary, setEvalSummary]       = useState<EvalSummary | null>(null);
  const [evalRunning, setEvalRunning]       = useState(false);
  const [metricsLoading, setMetricsLoading] = useState(false);

  // Auto-scroll chat to bottom on new messages
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-refresh live metrics when eval tab is open
  // useEffect watches tab state — fires every time user switches to eval tab
  useEffect(() => {
    if (tab !== "eval") return;
    fetchLiveMetrics();
  }, [tab]);

  async function fetchLiveMetrics() {
    setMetricsLoading(true);
    try {
      const m = await getEvalMetrics();
      setLiveMetrics(m);
    } catch (err: any) {
      console.error("Failed to fetch metrics:", err.message);
    } finally {
      setMetricsLoading(false);
    }
  }

  async function handleRunEval() {
    setEvalRunning(true);
    setEvalSummary(null);
    try {
      const summary = await runEvalDataset();
      setEvalSummary(summary);
      // Refresh live metrics after eval run so cards update immediately
      await fetchLiveMetrics();
    } catch (err: any) {
      console.error("Eval failed:", err.message);
    } finally {
      setEvalRunning(false);
    }
  }

  /**
   * Sends the user's message to the backend and appends the response
   * Also handles clicking a follow-up question chip
   */
  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;

    // Add user message to chat immediately (optimistic UI)
    // Optimistic UI = show the message before the server responds
    // Makes the app feel faster even though the response takes 1-3s
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    setCitations([]);

    try {
      const res = await chatApi(text, sessionId, agentMode);

      // Persist sessionId for conversation continuity (Phase 3 memory)
      setSessionId(res.sessionId);

      // Add assistant response with follow-up questions
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.answer,
          followUpQuestions: res.followUpQuestions,
        },
      ]);

      // Update citations panel with sources used for this answer
      setCitations(res.citations);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err.message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Ingests a document into Chroma via POST /ingest
   */
  async function handleUpload() {
    if (!docContent.trim() || !docFilename.trim()) return;
    setUploading(true);
    setUploadStatus(null);
    try {
      const res = await ingestApi(docContent, docFilename);
      setUploadStatus(`✅ Stored ${res.chunksStored} chunks from "${res.filename}"`);
      setDocContent("");
      setDocFilename("");
    } catch (err: any) {
      setUploadStatus(`❌ ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  /**
   * Fetches a URL and ingests it into Chroma via POST /ingest-url (Phase 6)
   * fetchMode controls which fetch tool is used:
   *   "node"   → our url_fetch (Node.js + cheerio, works on corporate proxy)
   *   "python" → mcp-server-fetch (Mozilla Readability, better quality)
   */
  async function handleUrlIngest() {
    if (!urlInput.trim()) return;
    setUrlIngesting(true);
    setUrlStatus(null);
    try {
      const res = await ingestUrlApi(urlInput.trim(), undefined, undefined, fetchMode);
      setUrlStatus(`✅ "${res.filename}" — ${res.chunksStored} chunks via ${res.source}`);
      setUrlInput("");
    } catch (err: any) {
      setUrlStatus(`❌ ${err.message}`);
    } finally {
      setUrlIngesting(false);
    }
  }

  // ── Helpers — formatting functions for the eval dashboard ─────
  // pct: converts 0.875 → "88%"
  // ms:  converts 1240  → "1240ms"
  // usd: converts 0.00312 → "$0.00312"
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const ms  = (n: number) => `${n.toFixed(0)}ms`;
  const usd = (n: number) => `$${n.toFixed(5)}`;

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">

      {/* ── Header ── */}
      <header className="flex items-center justify-between px-6 py-3 bg-gray-900 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">⚡ AIsde — RAG Chat</h1>

          {/* Session memory indicator — shows when a session is active (Phase 3) */}
          {sessionId && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-900 text-green-400 border border-green-800">
              🧠 Memory active · {messages.length} turns
            </span>
          )}

          {/* Agent mode indicator — shows which pipeline is active (Phase 4) */}
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            agentMode
              ? "bg-purple-900 text-purple-300 border-purple-700"
              : "bg-gray-800 text-gray-400 border-gray-700"
          }`}>
            {agentMode ? "🤖 Agent mode" : "⚡ Baseline RAG"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Tab switcher — Chat vs Eval (Phase 5) */}
          <div className="flex rounded-md overflow-hidden border border-gray-700">
            <button
              onClick={() => setTab("chat")}
              className={`text-sm px-3 py-1.5 transition ${tab === "chat" ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}
            >
              💬 Chat
            </button>
            <button
              onClick={() => setTab("eval")}
              className={`text-sm px-3 py-1.5 transition ${tab === "eval" ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}
            >
              📊 Eval
            </button>
          </div>

          {/* Agent mode toggle — switches between baseline and multi-agent pipeline (Phase 4) */}
          <button
            onClick={() => setAgentMode((m) => !m)}
            className={`text-sm px-3 py-1.5 rounded-md transition ${
              agentMode ? "bg-purple-700 hover:bg-purple-600 text-white" : "bg-gray-700 hover:bg-gray-600 text-gray-300"
            }`}
          >
            {agentMode ? "Disable Agents" : "Enable Agents"}
          </button>

          {/* Clear session button — resets memory by dropping sessionId (Phase 3) */}
          {sessionId && (
            <button
              onClick={() => { setSessionId(undefined); setMessages([]); setCitations([]); }}
              className="text-sm px-3 py-1.5 rounded-md bg-gray-700 hover:bg-gray-600 transition text-gray-300"
            >
              Clear Session
            </button>
          )}

          <button
            onClick={() => setUploadOpen((o) => !o)}
            className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 transition"
          >
            {uploadOpen ? "Close Upload" : "Upload Document"}
          </button>
        </div>
      </header>

      {/* ── Upload Panel ── */}
      {uploadOpen && (
        <div className="bg-gray-900 border-b border-gray-800 px-6 py-4 space-y-4">

          {/* ── Section 1: Ingest URL (Phase 6) ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-300">Ingest from URL</p>
              {/* fetchMode toggle — choose which fetch tool to use */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Fetch via:</span>
                <div className="flex rounded-md overflow-hidden border border-gray-700">
                  <button
                    onClick={() => setFetchMode("node")}
                    className={`text-xs px-2 py-1 transition ${
                      fetchMode === "node"
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                    }`}
                  >
                    ⚡ Node.js
                  </button>
                  <button
                    onClick={() => setFetchMode("python")}
                    className={`text-xs px-2 py-1 transition ${
                      fetchMode === "python"
                        ? "bg-green-700 text-white"
                        : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                    }`}
                  >
                    🐍 Python
                  </button>
                </div>
                <span className="text-xs text-gray-600">
                  {fetchMode === "node" ? "(cheerio, proxy-safe)" : "(Readability, better quality)"}
                </span>
              </div>
            </div>
            <p className="text-xs text-gray-500">
              Paste any URL — the page will be fetched, HTML stripped, chunked and stored in Chroma.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="https://example.com/docs"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleUrlIngest()}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={handleUrlIngest}
                disabled={urlIngesting || !urlInput.trim()}
                className="px-4 py-2 text-sm rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 transition whitespace-nowrap"
              >
                {urlIngesting ? "Fetching..." : "Ingest URL"}
              </button>
            </div>
            {urlStatus && <p className="text-xs text-gray-300">{urlStatus}</p>}
          </div>

          <div className="border-t border-gray-800" />

          {/* ── Section 2: Ingest Text (original) ── */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-300">Ingest from text</p>
            <p className="text-sm text-gray-400">
              Paste document text below and give it a filename.
            </p>
            <input
              type="text"
              placeholder="filename.txt"
              value={docFilename}
              onChange={(e) => setDocFilename(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <textarea
              placeholder="Paste document content here..."
              value={docContent}
              onChange={(e) => setDocContent(e.target.value)}
              rows={4}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={handleUpload}
                disabled={uploading || !docContent.trim() || !docFilename.trim()}
                className="px-4 py-2 text-sm rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 transition"
              >
                {uploading ? "Uploading..." : "Ingest Document"}
              </button>
              {uploadStatus && <span className="text-sm text-gray-300">{uploadStatus}</span>}
            </div>
          </div>
        </div>
      )}

      {/* ── Tab: Chat ── */}
      {tab === "chat" && (
        <div className="flex flex-1 overflow-hidden">

          {/* ── Chat Panel ── */}
          <div className="flex flex-col flex-1 overflow-hidden">

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {messages.length === 0 && (
                <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                  Ask a question about your ingested documents.
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-[75%] space-y-2">

                    {/* Message bubble */}
                    <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === "user"
                        ? "bg-indigo-600 text-white rounded-br-sm"
                        : "bg-gray-800 text-gray-100 rounded-bl-sm"
                    }`}>
                      {msg.content}
                    </div>

                    {/* Follow-up question chips — only on assistant messages */}
                    {msg.role === "assistant" && msg.followUpQuestions && msg.followUpQuestions.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {msg.followUpQuestions.map((q, qi) => (
                          <button
                            key={qi}
                            onClick={() => sendMessage(q)}
                            className="text-xs px-3 py-1.5 rounded-full bg-gray-700 hover:bg-indigo-600 border border-gray-600 hover:border-indigo-500 transition text-gray-300 hover:text-white"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Loading indicator */}
              {loading && (
                <div className="flex justify-start">
                  <div className="px-4 py-3 rounded-2xl bg-gray-800 text-sm text-gray-400 animate-pulse">
                    Thinking...
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* Input box */}
            <div className="px-6 py-4 border-t border-gray-800 bg-gray-900">
              <div className="flex gap-3">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMessage(input)}
                  placeholder="Ask a question about your documents..."
                  disabled={loading}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                />
                <button
                  onClick={() => sendMessage(input)}
                  disabled={loading || !input.trim()}
                  className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-sm font-medium transition"
                >
                  Send
                </button>
              </div>
            </div>
          </div>

          {/* ── Citations Panel ── */}
          <div className="w-80 border-l border-gray-800 bg-gray-900 overflow-y-auto flex-shrink-0">
            <div className="px-4 py-3 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                Citations
              </h2>
            </div>

            {citations.length === 0 ? (
              <div className="px-4 py-6 text-sm text-gray-600 text-center">
                Citations from retrieved chunks will appear here.
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {citations.map((c, i) => (
                  <div key={i} className="px-4 py-3 space-y-1.5">
                    {/* Source filename + score */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-indigo-400 truncate">
                        📄 {c.source}
                      </span>
                      {c.score !== undefined && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 ml-2 flex-shrink-0">
                          {(c.score * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    {/* Chunk preview — truncated to keep panel clean */}
                    <p className="text-xs text-gray-400 leading-relaxed line-clamp-4">
                      {c.chunk}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tab: Eval (Phase 5) ── */}
      {tab === "eval" && (
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">

          {/* ── Live Metrics Cards ── */}
          {/* Populated from the in-memory log buffer — updates on every request */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                📊 Live Metrics (from log buffer)
              </h2>
              <button
                onClick={fetchLiveMetrics}
                disabled={metricsLoading}
                className="text-xs px-3 py-1.5 rounded-md bg-gray-700 hover:bg-gray-600 transition disabled:opacity-40"
              >
                {metricsLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            {liveMetrics ? (
              <div className="grid grid-cols-3 gap-3">
                {/* Each card: metric name + value + explanation */}
                {[
                  {
                    label: "Total Requests",
                    value: liveMetrics.totalRequests.toString(),
                    // How many chat requests have been made since server start
                    sub: "since server start",
                    color: "text-blue-400",
                  },
                  {
                    label: "Avg Retrieval Score",
                    value: pct(liveMetrics.avgRetrievalScore),
                    // Higher = retrieved chunks are more semantically similar to the query
                    sub: "top chunk similarity",
                    color: liveMetrics.avgRetrievalScore > 0.7 ? "text-green-400" : "text-yellow-400",
                  },
                  {
                    label: "Avg Critic Score",
                    value: liveMetrics.avgCriticScore > 0 ? `${liveMetrics.avgCriticScore.toFixed(1)}/10` : "N/A",
                    // Only populated in agent mode — faithfulness of answer vs citations
                    sub: "agent mode only",
                    color: liveMetrics.avgCriticScore >= 7 ? "text-green-400" : "text-yellow-400",
                  },
                  {
                    label: "Critic Pass Rate",
                    value: liveMetrics.criticPassRate > 0 ? pct(liveMetrics.criticPassRate) : "N/A",
                    // % of agent mode requests where critic scored >= 7
                    sub: "score >= 7 threshold",
                    color: liveMetrics.criticPassRate > 0.8 ? "text-green-400" : "text-yellow-400",
                  },
                  {
                    label: "Avg Latency",
                    value: ms(liveMetrics.avgLatencyMs),
                    // Total request latency including all LLM calls
                    sub: "end-to-end per request",
                    color: liveMetrics.avgLatencyMs < 3000 ? "text-green-400" : "text-yellow-400",
                  },
                  {
                    label: "Avg Cost",
                    value: usd(liveMetrics.avgCostUsd),
                    // Estimated OpenAI API cost per request (gpt-4o-mini pricing)
                    sub: "gpt-4o-mini pricing",
                    color: "text-gray-300",
                  },
                ].map((card) => (
                  <div key={card.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-1">
                    <p className="text-xs text-gray-500 uppercase tracking-wider">{card.label}</p>
                    <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
                    <p className="text-xs text-gray-600">{card.sub}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-gray-600 py-4">
                {metricsLoading ? "Loading metrics..." : "No metrics yet — make some chat requests first."}
              </div>
            )}
          </div>

          {/* ── Eval Dataset Runner ── */}
          {/* Runs 8 fixed QA pairs through the pipeline and measures quality */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                  🧪 Eval Dataset Runner
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  Runs 8 test questions through the pipeline. Measures retrieval recall + answer relevance.
                  Costs ~8 API calls (~$0.01).
                </p>
              </div>
              <button
                onClick={handleRunEval}
                disabled={evalRunning}
                className="text-sm px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 transition"
              >
                {evalRunning ? "Running eval (~30s)..." : "Run Eval Dataset"}
              </button>
            </div>

            {evalSummary && (
              <div className="space-y-4">
                {/* Summary score cards */}
                <div className="grid grid-cols-4 gap-3">
                  {[
                    {
                      label: "Retrieval Recall",
                      value: pct(evalSummary.avgRetrievalRecall),
                      // Did the correct chunk appear in top-k results?
                      sub: "correct chunk retrieved",
                      color: evalSummary.avgRetrievalRecall > 0.7 ? "text-green-400" : "text-red-400",
                    },
                    {
                      label: "Answer Relevance",
                      value: pct(evalSummary.avgAnswerRelevance),
                      // Did the answer contain expected keywords?
                      sub: "expected keywords found",
                      color: evalSummary.avgAnswerRelevance > 0.7 ? "text-green-400" : "text-red-400",
                    },
                    {
                      label: "Avg Chunk Score",
                      value: pct(evalSummary.avgTopChunkScore),
                      // Average top similarity score across all eval questions
                      sub: "similarity score",
                      color: evalSummary.avgTopChunkScore > 0.7 ? "text-green-400" : "text-yellow-400",
                    },
                    {
                      label: "Avg Latency",
                      value: ms(evalSummary.avgLatencyMs),
                      sub: "per question",
                      color: "text-gray-300",
                    },
                  ].map((card) => (
                    <div key={card.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-1">
                      <p className="text-xs text-gray-500 uppercase tracking-wider">{card.label}</p>
                      <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
                      <p className="text-xs text-gray-600">{card.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Per-question results table */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase">
                        <th className="text-left px-4 py-3">Question</th>
                        <th className="text-center px-3 py-3">Recall</th>
                        <th className="text-center px-3 py-3">Relevance</th>
                        <th className="text-center px-3 py-3">Chunk Score</th>
                        <th className="text-center px-3 py-3">Latency</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {evalSummary.results.map((r) => (
                        <tr key={r.id} className="hover:bg-gray-800 transition">
                          <td className="px-4 py-3 text-gray-300 max-w-xs truncate">{r.question}</td>
                          <td className="px-3 py-3 text-center">
                            <span className={`font-medium ${r.retrievalRecall === 1 ? "text-green-400" : "text-red-400"}`}>
                              {r.retrievalRecall === 1 ? "✅" : "❌"}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className={`font-medium ${r.answerRelevance === 1 ? "text-green-400" : "text-red-400"}`}>
                              {r.answerRelevance === 1 ? "✅" : "❌"}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-center text-gray-400">
                            {pct(r.topChunkScore)}
                          </td>
                          <td className="px-3 py-3 text-center text-gray-400">
                            {ms(r.latencyMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="text-xs text-gray-600">
                  Ran at {new Date(evalSummary.ranAt).toLocaleString()}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
