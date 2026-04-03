/**
 * summarizer.ts — Compresses conversation history into a compact memory string
 *
 * WHY SUMMARIZE?
 * Each turn added to the prompt costs tokens. A long conversation would eventually:
 *   1. Exceed the LLM's context window (token limit)
 *   2. Make responses slower and more expensive
 *
 * Instead of keeping all turns, we:
 *   1. Keep the last MAX_TURNS turns in full (most relevant recent context)
 *   2. Summarize everything older into a single compact paragraph
 *   3. Inject both into the prompt: summary + recent turns
 *
 * EXAMPLE:
 *   Before summarization (8 turns):
 *     Turn 1: user: "What is RAG?"
 *     Turn 2: assistant: "RAG stands for..."
 *     Turn 3: user: "How does chunking work?"
 *     Turn 4: assistant: "Chunking splits documents..."
 *     Turn 5: user: "What embedding model do you use?"
 *     Turn 6: assistant: "We use text-embedding-3-small..."
 *     Turn 7: user: "What is topK?"
 *     Turn 8: assistant: "topK is the number of chunks..."
 *
 *   After summarization (MAX_TURNS=6, so turns 1-2 get summarized):
 *     summary: "User asked about RAG and received an explanation of Retrieval Augmented Generation."
 *     recent turns: turns 3-8 (kept in full)
 *
 * PROMPT INJECTION (in chat.ts):
 *   System prompt includes:
 *     "Previous conversation summary: <summary>"
 *     "Recent conversation: <last N turns>"
 *     "Retrieved context: <Chroma chunks>"
 */

import OpenAI from "openai";
import {
  getSession,
  updateSessionSummary,
  MAX_TURNS,
  Turn,
} from "./store";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Checks if a session needs summarization and runs it if so
 * Called after every chat turn in chat.ts
 *
 * @param sessionId - Session to check and potentially summarize
 *
 * Flow:
 *   turns.length <= MAX_TURNS → do nothing (not enough history yet)
 *   turns.length >  MAX_TURNS → summarize oldest turns, keep recent ones
 */
export async function maybeSummarize(sessionId: string): Promise<void> {
  const session = getSession(sessionId);

  // Not enough turns yet — no summarization needed
  if (session.turns.length <= MAX_TURNS) {
    console.log(`[summarizer] Session ${sessionId}: ${session.turns.length} turns, no summarization needed`);
    return;
  }

  // Split turns: old ones get summarized, recent ones are kept in full
  // Example with MAX_TURNS=6 and 8 turns:
  //   turnsToSummarize = turns[0..1] (2 oldest turns)
  //   recentTurns      = turns[2..7] (6 most recent turns)
  const turnsToSummarize: Turn[] = session.turns.slice(0, session.turns.length - MAX_TURNS);
  const recentTurns: Turn[] = session.turns.slice(session.turns.length - MAX_TURNS);

  console.log(`[summarizer] Summarizing ${turnsToSummarize.length} old turns for session ${sessionId}`);

  // Format old turns as readable text for the LLM to summarize
  const historyText = turnsToSummarize
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  // If there's an existing summary, include it so we build on it incrementally
  // This avoids re-summarizing the same content on every turn
  const existingSummary = session.summary
    ? `Previous summary: ${session.summary}\n\nNew conversation to add:\n${historyText}`
    : historyText;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Summarize the following conversation into 2-3 sentences. " +
          "Focus on what topics were discussed and what was concluded. " +
          "Be concise — this summary will be injected into future prompts.",
      },
      { role: "user", content: existingSummary },
    ],
  });

  const newSummary = completion.choices[0].message.content ?? "";
  console.log(`[summarizer] New summary for session ${sessionId}: "${newSummary}"`);

  // Store the new summary and trimmed turns back into the session
  updateSessionSummary(sessionId, newSummary, recentTurns);
}

/**
 * Formats the session memory into a string ready to inject into the LLM prompt
 * Returns empty string if no memory exists yet (first turn of a session)
 *
 * @param sessionId - Session to format memory for
 * @returns         - Formatted memory string or empty string
 *
 * Example output:
 *   "=== Conversation Memory ===
 *    Summary of earlier conversation: User asked about RAG and chunking strategies.
 *
 *    Recent conversation:
 *    User: What embedding model do you use?
 *    Assistant: We use text-embedding-3-small from OpenAI.
 *    User: What is topK?
 *    Assistant: topK is the number of chunks retrieved from Chroma."
 */
export function formatMemoryForPrompt(sessionId: string): string {
  const session = getSession(sessionId);

  // No history yet — first message in this session
  if (!session.summary && session.turns.length === 0) return "";

  const parts: string[] = ["=== Conversation Memory ==="];

  if (session.summary) {
    parts.push(`Summary of earlier conversation: ${session.summary}`);
  }

  if (session.turns.length > 0) {
    parts.push("\nRecent conversation:");
    session.turns.forEach((t) => {
      parts.push(`${t.role === "user" ? "User" : "Assistant"}: ${t.content}`);
    });
  }

  return parts.join("\n");
}
