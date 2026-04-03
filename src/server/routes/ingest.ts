/**
 * ingest.ts — POST /ingest route
 *
 * PURPOSE:
 * Accepts a document (text + filename + metadata), processes it through
 * the full ingestion pipeline, and stores it in Chroma for later retrieval.
 *
 * PIPELINE:
 *   Request body
 *     ↓
 *   Zod validation (reject bad input early)
 *     ↓
 *   chunkText()    — split document into overlapping chunks
 *     ↓
 *   embedBatch()   — convert all chunks to vectors in one API call
 *     ↓
 *   upsertChunks() — store chunks + vectors + metadata in Chroma
 *     ↓
 *   Response: { success, chunksStored, filename }
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
import { chunkText } from "../../lib/rag/chunking";
import { embedBatch } from "../../lib/embeddings/openai";
import { upsertChunks } from "../../lib/chroma/client";
import { log } from "../../lib/observability/logger";

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
    // Step 1: Split the document into chunks
    // e.g. a 2000-char doc with CHUNK_SIZE=500 → 5 chunks
    const chunks = chunkText(content, filename, metadata);
    console.log("Chunks for ingestion", chunks);
    // Step 2: Extract just the text from each chunk for embedding
    const texts = chunks.map((c) => c.text);

    // Step 3: Embed all chunks in a single OpenAI API call (efficient)
    // Returns one vector per chunk: [[0.12, ...], [0.33, ...], ...]
    const embeddings = await embedBatch(texts);
    console.log("Emddeding from text", embeddings);
    // Step 4: Build unique IDs for each chunk
    // Format: "filename::chunkIndex" e.g. "rag-intro.txt::0", "rag-intro.txt::1"
    // Using upsert means re-ingesting the same file updates existing chunks
    const ids = chunks.map((c) => `${filename}::${c.index}`);

    // Step 5: Merge filename into each chunk's metadata
    // This ensures every chunk stored in Chroma knows which file it came from
    const metadatas = chunks.map((c) => ({ filename, ...c.metadata }));
    console.log("Ids, embedding , texts,metadatas for insertion in croma", ids, embeddings, metadatas);
    // Step 6: Store everything in Chroma
    await upsertChunks(ids, embeddings, texts, metadatas);

    // ── Phase 5: Structured log ─────────────────────────────────
    log({
      phase: "ingest",
      filename,
      chunks: chunks.length,
      chunkStrategy: chunks[0]?.strategy ?? "unknown",
      latencyMs: Date.now() - start,
    });

    const response: IngestResponse = {
      success: true,
      chunksStored: chunks.length,
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
