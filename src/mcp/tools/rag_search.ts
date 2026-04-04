/**
 * rag_search.ts — MCP Tool: rag_search
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHAT IS AN MCP TOOL?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * An MCP tool is a function exposed via the MCP protocol with:
 *   1. A NAME        — how agents refer to it ("rag_search")
 *   2. A DESCRIPTION — what the tool does (LLM reads this to decide when to use it)
 *   3. An INPUT SCHEMA — JSON Schema defining required/optional parameters
 *   4. A HANDLER     — the actual function that runs when the tool is called
 *
 * COMPARE: Direct call vs MCP tool call
 *
 * PHASE 4 (direct):
 *   import { retrieve } from "../rag/retriever";
 *   const result = await retrieve("What is RAG?", 5);
 *   // ❌ Only our TypeScript code can call this
 *   // ❌ Caller must know the function signature
 *   // ❌ No standard way to discover it
 *
 * PHASE 6 (MCP):
 *   const result = await mcpClient.callTool("rag_search", { query: "What is RAG?", topK: 5 });
 *   // ✅ Any MCP client can call this (Claude, Cursor, GPT, n8n, our agents)
 *   // ✅ Caller discovers the schema automatically via tools/list
 *   // ✅ Standard protocol — language agnostic
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * TOOL DEFINITION STRUCTURE:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * {
 *   name: "rag_search",
 *   description: "...",   ← LLM reads this to decide WHEN to use the tool
 *   inputSchema: { ... }  ← JSON Schema — what parameters the tool accepts
 * }
 *
 * The description is critical — it's what the LLM uses to decide
 * "should I call rag_search for this query?" Make it clear and specific.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INPUT / OUTPUT:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Input:
 *   { "query": "What is RAG?", "topK": 5 }
 *
 * Output (MCP content array):
 *   [{ type: "text", text: JSON.stringify({ chunks, citations }) }]
 *
 * WHY content array?
 * MCP tools return an array of "content blocks" — each block has a type
 * (text, image, resource). We use type="text" with JSON stringified output.
 * This is the standard MCP response format all clients understand.
 */

import { retrieve } from "../../lib/rag/retriever";

// ── Tool definition ───────────────────────────────────────────────
// This object is registered with the MCP server in server.ts
// The MCP SDK uses it to:
//   1. Respond to tools/list requests (discovery)
//   2. Validate incoming tool call arguments against inputSchema
//   3. Route tools/call requests to the correct handler

export const ragSearchTool = {
  name: "rag_search",

  // Description is what the LLM reads to decide when to use this tool
  // Be specific: what does it search? what does it return?
  description:
    "Search the RAG knowledge base for relevant document chunks. " +
    "Use this when you need to find information from ingested documents. " +
    "Returns the top matching chunks with their source filenames and similarity scores.",

  // JSON Schema for input validation
  // The MCP SDK validates incoming arguments against this before calling handler
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "The search query — a question or topic to search for",
      },
      topK: {
        type: "number",
        description: "Number of chunks to return (default: 5, max: 10)",
        default: 5,
      },
    },
    required: ["query"],
  },
};

// ── Tool handler ──────────────────────────────────────────────────
// Called by the MCP server when a client invokes "rag_search"
// Wraps our existing retrieve() function — no duplication of logic

/**
 * Handles a rag_search tool call
 *
 * @param args - Validated arguments from the MCP client
 * @returns    - MCP content array with JSON stringified results
 *
 * Example call from any MCP client:
 *   { "name": "rag_search", "arguments": { "query": "What is RAG?", "topK": 3 } }
 *
 * Example response:
 *   [{
 *     "type": "text",
 *     "text": "{\"chunks\":[\"RAG stands for...\"],\"citations\":[{\"source\":\"doc.txt\",\"score\":0.92}]}"
 *   }]
 */
export async function handleRagSearch(args: { query: string; topK?: number }) {
  const { query, topK = 5 } = args;

  console.log(`[mcp:rag_search] query="${query}" topK=${topK}`);

  // Reuse our existing retrieve() — MCP is just a protocol wrapper
  // The actual retrieval logic (embed → search Chroma → return chunks) is unchanged
  const { citations } = await retrieve(query, Math.min(topK, 10));

  const result = {
    chunks: citations.map((c) => c.chunk),
    citations: citations.map((c) => ({
      source: c.source,
      score: c.score,
      // Truncate chunk preview for cleaner MCP response
      preview: c.chunk.slice(0, 200),
    })),
  };

  console.log(`[mcp:rag_search] returned ${citations.length} chunks`);

  // MCP tools must return content as an array of content blocks
  // type: "text" = plain text or JSON string
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
