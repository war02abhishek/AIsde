/**
 * ingest.ts — POST /ingest route
 *
 * PURPOSE:
 * Accepts a document (text + filename + metadata), processes it through
 * the full ingestion pipeline, and stores it in Chroma for later retrieval.
 *
 * PIPELINE (Phase 1-5 — direct Chroma calls, commented out below):
 *   Request body
 *     ↓
 *   Zod validation (reject bad input early)
 *     ↓
 *   chunkText()    — split document into overlapping chunks
 *     ↓
 *   embedBatch()   — convert all chunks to vectors in one API call
 *     ↓
 *   upsertChunks() — store chunks + vectors + metadata in Chroma directly
 *     ↓
 *   Response: { success, chunksStored, filename }
 *
 * PIPELINE (Phase 6 refactor — via multiClient MCP tool, active below):
 *   Request body
 *     ↓
 *   Zod validation
 *     ↓
 *   multiClient.callTool("rag_ingest") — goes through MCP protocol
 *     → rag_ingest tool handler: chunkText + embedBatch + upsertChunks
 *     ↓
 *   Response: { success, chunksStored, filename }
 *
 * WHY THIS REFACTOR?
 *   Before: ingest.ts directly imported chunkText, embedBatch, upsertChunks
 *           Tightly coupled to internal implementation
 *   After:  ingest.ts calls multiClient.callTool("rag_ingest")
 *           Goes through MCP protocol — same tool used by agents + ingest-url
 *           In production (Model B): this HTTP call goes to the MCP service
 *           One consistent ingestion path for ALL callers ✅
 *
 * EXAMPLE REQUEST:
 *   POST /ingest
 *   {
 *     "content": "RAG stands for Retrieval Augmented Generation...",
 *     "filename": "rag-intro.txt",
 *     "metadata": { "author": "admin", "topic": "RAG" }
 *   }
 *
 * EXAMPLE RESPONSE:
 *   { "success": true, "chunksStored": 2, "filename": "rag-intro.txt" }
 */

import { Router, Request, Response } from "express";
import { IngestRequestSchema, IngestResponse } from "../../lib/schemas/answer";
import { log } from "../../lib/observability/logger";
import { multiClient} from "../multi-client"

// ── PHASE 1-5: Direct imports (commented out — replaced by multiClient below) ──
// These were the original direct calls to internal modules.
// Kept here so you can see exactly what multiClient.callTool("rag_ingest") does internally.
// The actual logic still lives in src/mcp/tools/rag_ingest.ts — nothing was deleted.
//
// import { chunkText } from "../../lib/rag/chunking";
// import { embedBatch } from "../../lib/embeddings/openai";
// import { upsertChunks } from "../../lib/chroma/client";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  // Validate request body against Zod schema
  // safeParse returns { success: true, data } or { success: false, error }
  // unlike parse(), it does NOT throw — we handle the error ourselves
  const parsed = IngestRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    // flatten() converts Zod's nested error structure into a readable format
    // e.g. { fieldErrors: { content: ["Required"] } }
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { content, filename, metadata = {} } = parsed.data;
  const start = Date.now();

  try {
    // ── PHASE 1-5: Direct pipeline (commented out — replaced by multiClient below) ──
    //
    // Step 1: Split the document into chunks
    // const chunks = chunkText(content, filename, metadata);
    // console.log("Chunks for ingestion", chunks);
    //
    // Step 2: Extract just the text from each chunk for embedding
    // const texts = chunks.map((c) => c.text);
    //
    // Step 3: Embed all chunks in a single OpenAI API call (efficient)
    // Returns one vector per chunk: [[0.12, ...], [0.33, ...], ...]
    // const embeddings = await embedBatch(texts);
    // console.log("Emddeding from text", embeddings);
    //
    // Step 4: Build unique IDs for each chunk
    // Format: "filename::chunkIndex" e.g. "rag-intro.txt::0", "rag-intro.txt::1"
    // Using upsert means re-ingesting the same file updates existing chunks
    // const ids = chunks.map((c) => `${filename}::${c.index}`);
    //
    // Step 5: Merge filename into each chunk's metadata
    // This ensures every chunk stored in Chroma knows which file it came from
    // const metadatas = chunks.map((c) => ({ filename, ...c.metadata }));
    // console.log("Ids, embedding , texts,metadatas for insertion in croma", ids, embeddings, metadatas);
    //
    // Step 6: Store everything in Chroma directly
    // await upsertChunks(ids, embeddings, texts, metadatas);

    // ── PHASE 6: Via multiClient MCP tool (active) ───────────────
    // multiClient.callTool("rag_ingest") routes to:
    //   Local dev:   in-process MCP server (InMemoryTransport)
    //   Production:  MCP HTTP service (StreamableHTTPClientTransport)
    //
    // The rag_ingest tool handler (src/mcp/tools/rag_ingest.ts) does:
    //   chunkText() → embedBatch() → upsertChunks()
    // Same logic as above — just behind the MCP protocol layer
    console.log(`[ingest] Calling rag_ingest via multiClient for "${filename}"...`);

    const mcpResponse = await multiClient.callTool("rag_ingest", {
      content,
      filename,
      metadata,
    });

    // Parse the JSON response from the MCP tool
    const mcpResult = JSON.parse(
      (mcpResponse.content as any[])[0]?.text ?? "{}"
    ) as { success: boolean; chunksStored: number; filename: string };

    console.log(`[ingest] rag_ingest complete: ${mcpResult.chunksStored} chunks stored for "${filename}"`);

    // ── Phase 5: Structured log ─────────────────────────────────
    // Note: chunkStrategy comes from the MCP tool response
    // In Phase 1-5 we had direct access to chunks[0].strategy
    // Now we log "sentence-aware" as default since that's what rag_ingest uses
    log({
      phase: "ingest",
      filename,
      chunks: mcpResult.chunksStored,
      chunkStrategy: "sentence-aware", // rag_ingest always uses sentence-aware chunking
      latencyMs: Date.now() - start,
    });

    const response: IngestResponse = {
      success: true,
      chunksStored: mcpResult.chunksStored,
      filename,
    };

    res.json(response);
  } catch (err: any) {
    // Preserve the HTTP status from OpenAI/Chroma errors (e.g. 429 = rate limit)
    const status = err?.status ?? 500;
    res.status(status).json({ error: err?.message ?? "Ingest failed" });
  }
});

export default router;
