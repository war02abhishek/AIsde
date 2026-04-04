/**
 * retrieval.ts — Retrieval Agent
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PHASE 4 — CONCEPT: WHAT DOES THE RETRIEVAL AGENT ADD OVER retrieve()?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Our Phase 1 retrieve() function:
 *   - Takes ONE query
 *   - Returns top-k chunks
 *   - No deduplication
 *
 * This Retrieval Agent (Phase 4):
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
 * PHASE 4 — HOW THIS MAPS TO FRAMEWORKS:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * No Framework (this file):
 *   Promise.all() for parallelism — you write it yourself
 *   Manual deduplication with a Map
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
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PHASE 6 — MCP UPGRADE: WHY WE CHANGED THE IMPORT
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * BEFORE (Phase 4) — direct function call, tightly coupled:
 *   import { retrieve } from "../rag/retriever";
 *   const result = await retrieve(query);
 *   ❌ Only our TypeScript agents can call this
 *   ❌ Caller must know the function signature
 *   ❌ No standard way to discover it
 *
 * AFTER (Phase 6) — MCP tool call, loosely coupled:
 *   import { searchDocs } from "../mcp/client";
 *   const result = await searchDocs(query);
 *   ✅ Any MCP client can call rag_search (Cursor, Claude, our agents)
 *   ✅ Caller discovers the schema via tools/list
 *   ✅ Swap the MCP server without changing agent code
 *   ✅ Language agnostic — Python agent can call the same tool
 *
 * The retrieval LOGIC is identical — we just changed the transport layer.
 * retrieve() still runs inside the MCP tool handler.
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 4: Direct import (commented out — replaced by MCP in Phase 6)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// This was the original Phase 4 approach — import retrieve() directly.
// It works but tightly couples the agent to our internal function.
// Kept here so you can see exactly what Phase 6 replaced.
//
// import { retrieve } from "../rag/retriever";
//
// Usage in retrievalNode (Phase 4):
//   const results = await Promise.all(
//     state.queries.map((query) => retrieve(query))
//   );
//   // Each result: { context: string, citations: Citation[] }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 6: MCP client import (active)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// searchDocs() calls the rag_search MCP tool via in-process transport.
// Same retrieval result as retrieve() but goes through the MCP protocol.
// This means Cursor, Claude Desktop, or any MCP client can also call
// the same rag_search tool — not just our agents.
import { searchDocs } from "../../mcp/client";
import { Citation } from "../schemas/answer";
import { AgentState } from "./state";

/**
 * Retrieval Agent node — runs all queries in parallel, deduplicates results
 *
 * INPUT  (reads from state): queries  (set by orchestrator node)
 * OUTPUT (writes to state):  contexts, citations
 *
 * @param state - Current agent state (needs state.queries set by orchestrator)
 * @returns     - Partial state update: { contexts, citations }
 *
 * ── PHASE 4 example (direct retrieve call) ──
 *   queries: ["What is RAG?", "How does chunking work?"]
 *
 *   Parallel retrieve() calls:
 *     retrieve("What is RAG?")            → { context, citations }
 *     retrieve("How does chunking work?") → { context, citations }
 *
 *   After deduplication + merge:
 *     contexts: ["[1] RAG stands for...", "[2] Chunking splits..."]
 *     citations: [4 citation objects]
 *
 * ── PHASE 6 example (MCP searchDocs call) ──
 *   queries: ["What is RAG?", "How does chunking work?"]
 *
 *   Parallel MCP tool calls:
 *     searchDocs("What is RAG?")            → { chunks, citations }
 *     searchDocs("How does chunking work?") → { chunks, citations }
 *
 *   Same deduplication + merge logic — result is identical.
 *   Difference: now ANY MCP client can trigger the same retrieval.
 */
export async function retrievalNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  console.log(`[retrieval] Running ${state.queries.length} queries via MCP in parallel`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 4: Direct parallel retrieve() calls (commented out)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Run all queries simultaneously using Promise.all
  // Each retrieve() call: embed query → search Chroma → return chunks
  //
  // const results = await Promise.all(
  //   state.queries.map((query) => retrieve(query))
  // );
  // Each result shape: { context: string, citations: Citation[] }
  // citations: [{ source: "doc.txt", chunk: "...", score: 0.92 }]

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 6: MCP tool calls via searchDocs() (active)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // searchDocs() calls rag_search MCP tool → same Chroma retrieval
  // but now goes through the standard MCP protocol layer
  // Result shape: { chunks: string[], citations: [{source, score, preview}] }
  const mcpResults = await Promise.all(
    state.queries.map((query) => searchDocs(query, 5))
  );

  // Deduplicate chunks across all query results
  // A chunk is identified by its text content — same text = same chunk
  // Using a Map: chunkText → Citation (Map preserves insertion order)
  //
  // PHASE 4 note: same deduplication logic, just different input shape
  // Phase 4: result.citations[i].chunk  (full chunk text)
  // Phase 6: result.chunks[i]           (full chunk from MCP response)
  const seen = new Map<string, Citation>();

  mcpResults.forEach((result, queryIndex) => {
    result.citations.forEach((c) => {
      // MCP tool returns preview (truncated) — use full chunk from chunks array
      const fullChunk = result.chunks[result.citations.indexOf(c)] ?? c.preview;
      if (!seen.has(fullChunk)) {
        seen.set(fullChunk, {
          source: c.source,
          chunk: fullChunk,
          score: c.score,
        });
        console.log(
          `[retrieval] Query ${queryIndex + 1}: new chunk from "${c.source}" (score: ${c.score?.toFixed(2)})`
        );
      } else {
        // Same chunk retrieved by multiple queries — skip duplicate
        console.log(
          `[retrieval] Query ${queryIndex + 1}: duplicate chunk skipped from "${c.source}"`
        );
      }
    });
  });

  const dedupedCitations = Array.from(seen.values());

  // Build a single merged context string from all unique chunks
  // Numbered [1], [2], ... so the LLM can reference specific sources
  // This is identical to Phase 4 — context format hasn't changed
  const mergedContext = dedupedCitations
    .map((c, i) => `[${i + 1}] (${c.source}): ${c.chunk}`)
    .join("\n\n");

  const totalRaw = mcpResults.reduce((sum, r) => sum + r.citations.length, 0);
  console.log(
    `[retrieval] Total unique chunks: ${dedupedCitations.length} (from ${totalRaw} raw results)`
  );

  return {
    contexts: [mergedContext], // single merged context string for the critic node
    citations: dedupedCitations,
  };
}
