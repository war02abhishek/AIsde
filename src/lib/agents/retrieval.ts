/**
 * retrieval.ts — Retrieval Agent
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHAT DOES THE RETRIEVAL AGENT ADD OVER PLAIN retrieve()?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Our Phase 1 retrieve() function:
 *   - Takes ONE query
 *   - Returns top-k chunks
 *   - No deduplication
 *
 * This Retrieval Agent:
 *   - Takes MULTIPLE queries (from orchestrator)
 *   - Runs them in PARALLEL (faster than sequential)
 *   - DEDUPLICATES results (same chunk from 2 queries = keep once)
 *   - MERGES contexts into one coherent string
 *
 * WHY PARALLEL?
 *   Sequential: query1(500ms) + query2(500ms) = 1000ms total
 *   Parallel:   Promise.all([query1, query2])  =  500ms total ✅
 *
 * WHY DEDUPLICATE?
 *   "What is RAG?" and "RAG definition" might retrieve the same chunk.
 *   Sending duplicate chunks wastes tokens and confuses the LLM.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * HOW THIS MAPS TO FRAMEWORKS:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * No Framework (this file):
 *   Promise.all() for parallelism — you write it yourself
 *   Manual deduplication with a Set
 *
 * LangGraph:
 *   You can use graph.addNode() with parallel branches:
 *     .addEdge("orchestrator", "retrieval_1")
 *     .addEdge("orchestrator", "retrieval_2")
 *   LangGraph runs both branches simultaneously and merges state
 *   Much cleaner than manual Promise.all ✅
 *
 * LangChain:
 *   MultiQueryRetriever — generates multiple queries automatically
 *   but you lose control over the query generation logic
 *
 * n8n:
 *   "Split In Batches" node + parallel HTTP calls
 *   Works but no type safety, hard to deduplicate
 */

import { retrieve } from "../rag/retriever";
import { Citation } from "../schemas/answer";
import { AgentState } from "./state";

/**
 * Retrieval Agent node — runs all queries in parallel, deduplicates results
 *
 * INPUT  (reads from state): queries
 * OUTPUT (writes to state):  contexts, citations
 *
 * @param state - Current agent state (needs state.queries set by orchestrator)
 * @returns     - Partial state update: { contexts, citations }
 *
 * Example with 2 queries:
 *   queries: ["What is RAG?", "How does chunking work?"]
 *
 *   Parallel retrieval:
 *     query1 → chunks: ["RAG stands for...", "RAG combines..."]
 *     query2 → chunks: ["Chunking splits...", "Overlap ensures..."]
 *
 *   After deduplication + merge:
 *     contexts: ["[1] RAG stands for...", "[2] RAG combines...",
 *                "[3] Chunking splits...", "[4] Overlap ensures..."]
 *     citations: [4 citation objects]
 */
export async function retrievalNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  console.log(`[retrieval] Running ${state.queries.length} queries in parallel`);

  // Run all queries simultaneously using Promise.all
  // Each retrieve() call: embed query → search Chroma → return chunks
  const results = await Promise.all(
    state.queries.map((query) => retrieve(query))
  );

  // Deduplicate chunks across all query results
  // A chunk is identified by its text content — same text = same chunk
  // Using a Map: chunkText → Citation (Map preserves insertion order)
  const seen = new Map<string, Citation>();

  results.forEach((result, queryIndex) => {
    result.citations.forEach((citation) => {
      if (!seen.has(citation.chunk)) {
        seen.set(citation.chunk, citation);
        console.log(
          `[retrieval] Query ${queryIndex + 1}: new chunk from "${citation.source}" (score: ${citation.score?.toFixed(2)})`
        );
      } else {
        console.log(
          `[retrieval] Query ${queryIndex + 1}: duplicate chunk skipped from "${citation.source}"`
        );
      }
    });
  });

  const dedupedCitations = Array.from(seen.values());

  // Build a single merged context string from all unique chunks
  // Numbered [1], [2], ... so the LLM can reference them
  const mergedContext = dedupedCitations
    .map((c, i) => `[${i + 1}] (${c.source}): ${c.chunk}`)
    .join("\n\n");

  console.log(
    `[retrieval] Total unique chunks: ${dedupedCitations.length} (from ${results.reduce((sum, r) => sum + r.citations.length, 0)} raw results)`
  );

  return {
    contexts: [mergedContext], // single merged context string
    citations: dedupedCitations,
  };
}
