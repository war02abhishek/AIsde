/**
 * critic.ts — Critic Agent
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHAT IS A CRITIC AGENT?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * The Critic is a SEPARATE LLM call that acts as a quality gate.
 * It reads the answer + the citations and asks:
 *   "Is every claim in this answer actually supported by the cited sources?"
 *
 * This is called "Citation Faithfulness" — a key RAG quality metric.
 *
 * WITHOUT a critic:
 *   LLM answer: "RAG uses BERT embeddings and stores in Pinecone"
 *   Citations:  ["RAG combines vector search with LLMs..."]
 *   Problem:    Answer hallucinated "BERT" and "Pinecone" — not in citations ❌
 *
 * WITH a critic:
 *   Critic reads answer + citations
 *   Critic: "BERT and Pinecone not mentioned in citations → score: 3/10 → FAIL"
 *   Graph retries retrieval with better queries ✅
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * TWO RESPONSIBILITIES OF THIS NODE:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. GENERATE the answer (calls generate() from generator.ts)
 *    Why here and not a separate node?
 *    Because the critic needs the answer to evaluate it.
 *    Generating + evaluating in one node saves a round trip.
 *
 * 2. EVALUATE the answer for citation faithfulness
 *    Score 1-10: >= 7 = PASS, < 7 = FAIL (retry retrieval)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * HOW THIS MAPS TO FRAMEWORKS:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * No Framework (this file):
 *   Two LLM calls in one async function
 *   Return criticPass: true/false to drive graph routing
 *
 * LangGraph:
 *   This node returns { criticPass, criticScore }
 *   The conditional edge reads criticPass:
 *     .addConditionalEdges("critic", (state) =>
 *       state.criticPass ? "end" : "retrieval"  ← loop back or finish
 *     )
 *   LangGraph handles the loop automatically ✅
 *
 * LangChain:
 *   No built-in critic pattern — you'd need to build this manually
 *   on top of LangChain, defeating the purpose of using it
 *
 * n8n:
 *   An "IF" node after an OpenAI node — but no typed state,
 *   no retry counter, no structured scoring
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RETRY LOOP EXAMPLE:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Attempt 1:
 *   Retrieval → 5 chunks → Generate → "RAG uses BERT embeddings"
 *   Critic: score 3 → FAIL → retryCount: 1
 *   → back to Retrieval with broader queries
 *
 * Attempt 2:
 *   Retrieval → 5 new chunks → Generate → "RAG uses text-embedding-3-small"
 *   Critic: score 9 → PASS ✅
 *   → final answer returned
 */

import OpenAI from "openai";
import { z } from "zod";
import { generate } from "../rag/generator";
import { AgentState } from "./state";
import { log } from "../observability/logger";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_RETRIES = 2; // max times we'll retry retrieval before giving up

/**
 * Zod schema for critic's evaluation output
 *
 * Example:
 *   {
 *     "score": 8,
 *     "reasoning": "Answer correctly states RAG uses vector search, supported by citation [1]",
 *     "issues": []
 *   }
 *
 *   {
 *     "score": 3,
 *     "reasoning": "Answer mentions BERT which is not in any citation",
 *     "issues": ["BERT not mentioned in citations", "Pinecone not mentioned in citations"]
 *   }
 */
const CriticOutputSchema = z.object({
  score: z.number().min(1).max(10),
  reasoning: z.string(),
  issues: z.array(z.string()), // specific problems found (empty if score >= 7)
});

/**
 * Critic Agent node — generates answer then evaluates its faithfulness
 *
 * INPUT  (reads from state): question, contexts, citations, memory, retryCount
 * OUTPUT (writes to state):  answer, followUpQuestions, criticPass, criticScore, retryCount
 *
 * @param state - Current agent state
 * @returns     - Partial state update with answer + critic evaluation
 */
export async function criticNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  const mergedContext = state.contexts[0] ?? "";

  const criticStart = Date.now();
  console.log(`[critic] Generating answer (attempt ${state.retryCount + 1}/${MAX_RETRIES + 1})`);

  // ── Step 1: Generate the answer using our existing generator ──
  // We reuse generate() from Phase 2 — no duplication
  const { answer, followUpQuestions } = await generate(
    state.question,
    mergedContext,
    state.memory
  );

  console.log(`[critic] Answer generated (${answer.length} chars). Now evaluating faithfulness...`);

  // ── Step 2: Evaluate citation faithfulness ────────────────────
  // Format citations as readable text for the critic LLM
  const citationText = state.citations
    .map((c, i) => `[${i + 1}] Source: ${c.source}\nContent: ${c.chunk}`)
    .join("\n\n");

  const criticCompletion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a citation faithfulness critic for a RAG system.
Your job: check if every factual claim in the answer is supported by the provided citations.

Score the answer 1-10:
  9-10: Every claim is directly supported by citations
  7-8:  Most claims supported, minor gaps
  5-6:  Some claims unsupported or vague
  1-4:  Answer contains hallucinations or claims not in citations

Respond with ONLY valid JSON:
{
  "score": <number 1-10>,
  "reasoning": "<brief explanation>",
  "issues": ["<issue1>", "<issue2>"] // empty array if score >= 7
}`,
      },
      {
        role: "user",
        content: `ANSWER TO EVALUATE:
${answer}

AVAILABLE CITATIONS:
${citationText}`,
      },
    ],
  });

  const criticRaw = criticCompletion.choices[0].message.content ?? "{}";
  const criticResult = CriticOutputSchema.parse(JSON.parse(criticRaw));

  const criticPass = criticResult.score >= 7;

  console.log(`[critic] Score: ${criticResult.score}/10 → ${criticPass ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`[critic] Reasoning: ${criticResult.reasoning}`);

  if (!criticPass) {
    console.log(`[critic] Issues: ${criticResult.issues.join(", ")}`);
    console.log(`[critic] RetryCount: ${state.retryCount} / ${MAX_RETRIES}`);
  }

  // ── Phase 5: Structured log ───────────────────────────────────
  log({
    phase: "critic",
    score: criticResult.score,
    pass: criticPass,
    issues: criticResult.issues,
    latencyMs: Date.now() - criticStart,
    sessionId: state.sessionId,
  });

  return {
    answer,
    followUpQuestions,
    criticPass,
    criticScore: criticResult.score,
    // Increment retry counter so graph knows when to stop retrying
    retryCount: state.retryCount + 1,
  };
}

/**
 * Routing function — called after critic node to decide next step
 * This is the "conditional edge" in LangGraph terminology
 *
 * Returns:
 *   "end"       → critic passed, return answer to user
 *   "retrieval" → critic failed + retries remaining, try again
 *   "end"       → critic failed but max retries reached, return best answer anyway
 *
 * In LangGraph this would be:
 *   graph.addConditionalEdges("critic", criticRouter, {
 *     "end": END,
 *     "retrieval": "retrieval"
 *   })
 *
 * @param state - Current state after critic node ran
 * @returns     - "end" or "retrieval"
 */
export function criticRouter(state: AgentState): "end" | "retrieval" {
  if (state.criticPass) {
    console.log(`[router] Critic passed → ending graph`);
    return "end";
  }

  if (state.retryCount >= MAX_RETRIES) {
    console.log(`[router] Max retries reached → ending graph with best answer`);
    return "end";
  }

  console.log(`[router] Critic failed → retrying retrieval (attempt ${state.retryCount + 1})`);
  return "retrieval";
}
