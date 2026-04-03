/**
 * orchestrator.ts — The "brain" agent that decides how to handle a question
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHAT DOES AN ORCHESTRATOR DO?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * The orchestrator is the FIRST node in the graph. It:
 *   1. Classifies the question: simple or complex?
 *   2. Rewrites/expands the query for better retrieval
 *   3. Sets the route so downstream nodes know what to do
 *
 * SIMPLE question = one clear topic, one retrieval needed
 *   "What is RAG?" → queries: ["What is RAG?"]
 *
 * COMPLEX question = multiple topics OR comparison OR multi-step
 *   "What is RAG and how does chunking work?" →
 *     queries: ["What is RAG?", "How does chunking work in RAG?"]
 *
 * WHY QUERY REWRITING?
 * Users ask questions in natural language which is often vague.
 * Rewriting improves retrieval quality significantly.
 *
 *   Original:  "how does it work?"
 *   Rewritten: "How does RAG retrieval work?" (uses memory context)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * HOW THIS MAPS TO FRAMEWORKS:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * No Framework (this file):
 *   Plain async function that takes state, returns partial state update
 *   You call it manually in graph.ts
 *
 * LangGraph:
 *   This becomes a "node" registered with graph.addNode("orchestrator", orchestratorNode)
 *   LangGraph calls it automatically when the graph reaches that node
 *   Return value is automatically merged into state (partial update)
 *
 * LangChain:
 *   No equivalent — LangChain chains don't have routing logic
 *   You'd have to build this yourself on top of LangChain anyway
 *
 * n8n:
 *   A "Switch" node with conditions — but you can't write LLM-based
 *   routing logic, only simple if/else on field values
 */

import OpenAI from "openai";
import { z } from "zod";
import { AgentState } from "./state";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Zod schema for orchestrator's structured output
 * The LLM must return this exact shape
 *
 * Example:
 *   {
 *     "route": "complex",
 *     "queries": ["What is RAG?", "How does chunking work in RAG?"],
 *     "reasoning": "Question has two distinct topics requiring separate retrievals"
 *   }
 */
const OrchestratorOutputSchema = z.object({
  route: z.enum(["simple", "complex"]),
  queries: z.array(z.string()).min(1).max(4),
  reasoning: z.string(), // why did it choose this route? great for debugging
});

/**
 * Orchestrator node — classifies question and prepares retrieval queries
 *
 * INPUT  (reads from state): question, memory
 * OUTPUT (writes to state):  route, queries
 *
 * @param state - Current agent state
 * @returns     - Partial state update: { route, queries }
 *
 * Flow:
 *   "What is RAG?"
 *     → LLM classifies: simple
 *     → queries: ["What is RAG?"]
 *
 *   "Compare RAG vs fine-tuning and explain chunking strategies"
 *     → LLM classifies: complex
 *     → queries: ["RAG vs fine-tuning comparison",
 *                 "chunking strategies for RAG",
 *                 "when to use RAG vs fine-tuning"]
 */
export async function orchestratorNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  console.log(`[orchestrator] Processing question: "${state.question}"`);

  const memoryContext = state.memory
    ? `\nConversation so far:\n${state.memory}`
    : "";

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a query orchestrator for a RAG system.
Analyze the user's question and decide:
1. Is it SIMPLE (one topic, one retrieval) or COMPLEX (multiple topics, needs multiple retrievals)?
2. Rewrite the question into 1-4 optimized search queries for a vector database.
   - Make queries specific and self-contained
   - If the question uses pronouns like "it" or "this", resolve them using conversation history
   - For complex questions, split into separate focused queries

${memoryContext}

Respond with ONLY valid JSON:
{
  "route": "simple" | "complex",
  "queries": ["query1", "query2", ...],
  "reasoning": "brief explanation of your decision"
}`,
      },
      { role: "user", content: state.question },
    ],
  });

  const raw = completion.choices[0].message.content ?? "{}";
  const parsed = OrchestratorOutputSchema.parse(JSON.parse(raw));

  console.log(`[orchestrator] Route: ${parsed.route}`);
  console.log(`[orchestrator] Queries: ${JSON.stringify(parsed.queries)}`);
  console.log(`[orchestrator] Reasoning: ${parsed.reasoning}`);

  // Return ONLY the fields this node is responsible for
  // In LangGraph this partial return is automatically merged into state
  return {
    route: parsed.route,
    queries: parsed.queries,
  };
}
