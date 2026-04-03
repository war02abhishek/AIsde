/**
 * state.ts — Shared state object that flows through every agent node
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHY DO WE NEED A SHARED STATE?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * In a multi-agent system, multiple agents need to READ and WRITE
 * shared data as the request flows through the graph.
 *
 * Think of it like a "baton" in a relay race — each agent picks it
 * up, adds their contribution, and passes it to the next agent.
 *
 * WITHOUT shared state (our old pipeline):
 *   retrieve(question) → generate(context) → done
 *   Each function only knows about its own inputs/outputs ❌
 *
 * WITH shared state (agent graph):
 *   Orchestrator sets:  state.route = "complex", state.queries = [...]
 *   Retrieval reads:    state.queries → fetches → sets state.contexts
 *   Critic reads:       state.contexts + state.answer → sets state.criticPass
 *   Each agent sees the FULL picture ✅
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * HOW THIS MAPS TO FRAMEWORKS:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * No Framework (this file):
 *   Plain TypeScript interface — you manage mutations manually
 *   AgentState is just an object passed between functions
 *
 * LangGraph (Phase 4 Step 2):
 *   Annotation.Root({ ... }) — LangGraph wraps this with:
 *     - Immutable updates (each node returns a PATCH, not full state)
 *     - Checkpointing (save state to DB for resumability)
 *     - Streaming (emit state updates in real time to UI)
 *   Example:
 *     const AgentState = Annotation.Root({
 *       question: Annotation<string>(),
 *       route: Annotation<string>(),
 *       ...
 *     })
 *
 * LangChain:
 *   No explicit state — data is passed implicitly through chain.call()
 *   You can't easily inspect what's happening between steps ❌
 *
 * n8n:
 *   State = the JSON payload passed between visual nodes
 *   You can see it in the UI but can't type it ❌
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * STATE LIFECYCLE EXAMPLE:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Initial state (from chat.ts):
 *   { question: "What is RAG and how does chunking work?",
 *     sessionId: "abc-123", memory: "...", route: "simple",
 *     queries: [], contexts: [], citations: [],
 *     answer: "", followUpQuestions: [],
 *     criticPass: false, criticScore: 0, retryCount: 0 }
 *
 * After Orchestrator:
 *   { ...same, route: "complex",
 *     queries: ["What is RAG?", "How does chunking work?"] }
 *
 * After Retrieval Agent:
 *   { ...same, contexts: ["RAG stands for...", "Chunking splits..."],
 *     citations: [{source: "rag-intro.txt", ...}] }
 *
 * After Generator (inside Critic node):
 *   { ...same, answer: "RAG is... Chunking works by...",
 *     followUpQuestions: ["What is topK?", ...] }
 *
 * After Critic Agent (pass):
 *   { ...same, criticPass: true, criticScore: 9 }
 *
 * Final output → chat.ts reads: answer, citations, followUpQuestions
 */

import { Citation } from "../schemas/answer";

export type RouteType = "simple" | "complex";

export interface AgentState {
  // ── Input (set once at the start, never changed) ──────────────
  question: string;      // original user question
  sessionId: string;     // for memory lookup
  memory: string;        // formatted memory string from summarizer

  // ── Orchestrator output ───────────────────────────────────────
  route: RouteType;      // "simple" = one retrieval, "complex" = multiple
  queries: string[];     // rewritten/expanded queries for retrieval
                         // simple: ["What is RAG?"]
                         // complex: ["What is RAG?", "How does chunking work?"]

  // ── Retrieval Agent output ────────────────────────────────────
  contexts: string[];    // one context string per query (merged for complex)
  citations: Citation[]; // all citations collected across all retrievals

  // ── Generator output (produced inside Critic node) ────────────
  answer: string;
  followUpQuestions: string[];

  // ── Critic Agent output ───────────────────────────────────────
  criticPass: boolean;   // true = answer is grounded, false = retry
  criticScore: number;   // faithfulness score 1-10 (>= 7 = pass)
  retryCount: number;    // how many times we've retried (max 2)
}

/**
 * Creates the initial state for a new agent run
 * Called once in chat.ts before invoking the graph
 *
 * @param question  - User's question
 * @param sessionId - Session ID for memory
 * @param memory    - Pre-formatted memory string
 *
 * Example:
 *   createInitialState("What is RAG?", "abc-123", "User asked about embeddings...")
 *   → { question: "What is RAG?", route: "simple", queries: [], ... }
 */
export function createInitialState(
  question: string,
  sessionId: string,
  memory: string
): AgentState {
  return {
    question,
    sessionId,
    memory,
    route: "simple",       // default — orchestrator may upgrade to "complex"
    queries: [],
    contexts: [],
    citations: [],
    answer: "",
    followUpQuestions: [],
    criticPass: false,
    criticScore: 0,
    retryCount: 0,
  };
}
