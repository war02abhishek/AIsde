/**
 * store.ts — In-memory session store for conversation history
 *
 * WHY SESSION MEMORY?
 * Without memory, every chat turn is independent. The LLM has no idea what
 * was said in previous turns. This causes problems like:
 *
 *   Turn 1: "What is RAG?"           → "RAG stands for Retrieval Augmented Generation"
 *   Turn 2: "How does it retrieve?"  → LLM doesn't know what "it" refers to ❌
 *
 * With memory injected into the prompt:
 *   Turn 2: "How does it retrieve?"  → LLM sees prior context → knows "it" = RAG ✅
 *
 * STRUCTURE PER SESSION:
 *   sessionId → {
 *     turns: [{ role, content }, ...],   ← raw conversation history
 *     summary: "User asked about RAG..." ← compressed memory (after summarization)
 *   }
 *
 * WHY SUMMARIZE?
 * Keeping all turns forever would eventually exceed the LLM's token limit.
 * When turns exceed MAX_TURNS, we summarize older turns into a compact string
 * and keep only the most recent turns in full.
 *
 * EXAMPLE:
 *   After 10 turns, summary = "User asked about RAG and chunking strategies.
 *   Assistant explained embeddings and vector search."
 *   Recent turns = last 4 turns (kept in full)
 */

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface SessionMemory {
  turns: Turn[];       // recent conversation turns kept in full
  summary: string;     // compressed older history (empty until first summarization)
}

// In-memory store: sessionId → SessionMemory
// NOTE: This resets on server restart. Phase 5 will add persistent storage.
const store = new Map<string, SessionMemory>();

// How many recent turns to keep in full before summarizing older ones
// Example: MAX_TURNS=6 means we keep last 6 turns, summarize everything before
export const MAX_TURNS = 6;

/**
 * Gets or creates a session memory object for a given sessionId
 *
 * @param sessionId - Unique session identifier (UUID from client)
 * @returns         - Existing or new SessionMemory object
 *
 * Example:
 *   getSession("abc-123") → { turns: [], summary: "" }  ← new session
 *   getSession("abc-123") → { turns: [...], summary: "..." } ← existing session
 */
export function getSession(sessionId: string): SessionMemory {
  if (!store.has(sessionId)) {
    console.log(`[memory] New session created: ${sessionId}`);
    store.set(sessionId, { turns: [], summary: "" });
  }
  return store.get(sessionId)!;
}

/**
 * Appends a new turn (user or assistant message) to the session
 *
 * @param sessionId - Session to update
 * @param role      - "user" or "assistant"
 * @param content   - Message text
 *
 * Example:
 *   addTurn("abc-123", "user", "What is RAG?")
 *   addTurn("abc-123", "assistant", "RAG stands for...")
 */
export function addTurn(sessionId: string, role: Turn["role"], content: string): void {
  const session = getSession(sessionId);
  session.turns.push({ role, content });
  console.log(`[memory] Session ${sessionId} now has ${session.turns.length} turns`);
}

/**
 * Updates the session with a new summary and trims old turns
 * Called by summarizer.ts after summarization
 *
 * @param sessionId  - Session to update
 * @param summary    - New compressed summary of older turns
 * @param recentTurns - Recent turns to keep in full (replaces all turns)
 */
export function updateSessionSummary(
  sessionId: string,
  summary: string,
  recentTurns: Turn[]
): void {
  const session = getSession(sessionId);
  session.summary = summary;
  session.turns = recentTurns;
  console.log(`[memory] Session ${sessionId} summarized. Kept ${recentTurns.length} recent turns.`);
}
