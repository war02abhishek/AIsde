/**
 * rag_ingest.ts — MCP Tool: rag_ingest
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHY EXPOSE INGEST AS AN MCP TOOL?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Without MCP:
 *   To ingest a document you must:
 *   - Know our Express API exists at POST /ingest
 *   - Know the exact request body shape
 *   - Be able to make HTTP requests to our server
 *
 * With MCP:
 *   Any MCP client (Claude Desktop, Cursor, our agents) can:
 *   - Discover "rag_ingest" exists via tools/list
 *   - Read the description to understand what it does
 *   - Call it with { content, filename } — no HTTP knowledge needed
 *
 * REAL WORLD USE CASE:
 *   Cursor IDE connects to our MCP server.
 *   You highlight code in your editor and say:
 *   "Ingest this file into the knowledge base"
 *   Cursor calls rag_ingest automatically — no manual API call needed.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PIPELINE (same as POST /ingest route):
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   content + filename
 *     ↓
 *   chunkText()    — sentence-aware chunking (Phase 5)
 *     ↓
 *   embedBatch()   — OpenAI embeddings
 *     ↓
 *   upsertChunks() — store in Chroma
 *     ↓
 *   return { chunksStored, filename }
 *
 * NOTE: We call the same functions as the /ingest route directly.
 * We do NOT make an HTTP call to our own Express server — that would
 * be wasteful. MCP is a protocol layer, not a network hop.
 */

import { chunkText } from "../../lib/rag/chunking";
import { embedBatch } from "../../lib/embeddings/openai";
import { upsertChunks } from "../../lib/chroma/client";

// ── Tool definition ───────────────────────────────────────────────

export const ragIngestTool = {
  name: "rag_ingest",

  description:
    "Ingest a document into the RAG knowledge base. " +
    "The document will be chunked, embedded, and stored in Chroma for future searches. " +
    "Use this when you want to add new information that agents can later retrieve.",

  inputSchema: {
    type: "object" as const,
    properties: {
      content: {
        type: "string",
        description: "The full text content of the document to ingest",
      },
      filename: {
        type: "string",
        description: "A unique name for this document (e.g. 'policy.txt', 'readme.md')",
      },
      metadata: {
        type: "object",
        description: "Optional key-value metadata to store alongside chunks (e.g. author, topic)",
        additionalProperties: { type: "string" },
      },
    },
    required: ["content", "filename"],
  },
};

// ── Tool handler ──────────────────────────────────────────────────

/**
 * Handles a rag_ingest tool call
 *
 * @param args - Validated arguments from the MCP client
 * @returns    - MCP content array with ingestion result
 *
 * Example call:
 *   {
 *     "name": "rag_ingest",
 *     "arguments": {
 *       "content": "RAG stands for Retrieval Augmented Generation...",
 *       "filename": "rag-intro.txt",
 *       "metadata": { "author": "admin" }
 *     }
 *   }
 *
 * Example response:
 *   [{ "type": "text", "text": "{\"success\":true,\"chunksStored\":3,\"filename\":\"rag-intro.txt\"}" }]
 */
export async function handleRagIngest(args: {
  content: string;
  filename: string;
  metadata?: Record<string, string>;
}) {
  const { content, filename, metadata = {} } = args;

  console.log(`[mcp:rag_ingest] filename="${filename}" content length=${content.length}`);

  // Step 1: Chunk the document using sentence-aware chunking (Phase 5)
  const chunks = chunkText(content, filename, metadata);

  // Step 2: Embed all chunks in one API call
  const texts = chunks.map((c) => c.text);
  const embeddings = await embedBatch(texts);

  // Step 3: Build IDs and metadata for Chroma
  // Same ID format as /ingest route: "filename::chunkIndex"
  const ids = chunks.map((c) => `${filename}::${c.index}`);
  const metadatas = chunks.map((c) => ({ filename, ...c.metadata }));

  // Step 4: Store in Chroma
  await upsertChunks(ids, embeddings, texts, metadatas);

  const result = {
    success: true,
    chunksStored: chunks.length,
    filename,
    strategy: chunks[0]?.strategy ?? "unknown",
  };

  console.log(`[mcp:rag_ingest] stored ${chunks.length} chunks for "${filename}"`);

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
