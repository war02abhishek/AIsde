/**
 * debug.ts — GET /debug/chunks and GET /debug/collections
 *
 * PURPOSE:
 * Development-only endpoints to inspect what's stored in Chroma.
 * Lets you verify chunks were actually stored after ingestion.
 *
 * ENDPOINTS:
 *   GET /debug/collections        → list all Chroma collections + count
 *   GET /debug/chunks             → list all chunks in our collection
 *   GET /debug/chunks?q=RAG       → search chunks by keyword
 *   GET /debug/chunks?file=doc.txt → filter chunks by filename
 *
 * ⚠️  DEVELOPMENT ONLY — remove or protect with auth before deploying
 */

import { Router, Request, Response } from "express";
import { ChromaClient } from "chromadb";

const router = Router();

// Same Chroma connection as client.ts
const chroma = new ChromaClient({
  host: process.env.CHROMA_HOST ?? "localhost",
  port: Number(process.env.CHROMA_PORT ?? 8000),
});

const COLLECTION = process.env.CHROMA_COLLECTION ?? "aisde_docs";

// Noop embedding function — same as client.ts, suppresses warning
const noopEmbeddingFunction = {
  generate: async (texts: string[]): Promise<number[][]> => texts.map(() => []),
};

/**
 * GET /debug/collections
 * Lists all Chroma collections with their document counts
 *
 * Example response:
 *   {
 *     "collections": [
 *       { "name": "aisde_docs", "count": 47, "id": "abc-123" }
 *     ]
 *   }
 */
router.get("/collections", async (_req: Request, res: Response) => {
  try {
    const collections = await chroma.listCollections();
    console.log(`[debug] Found ${collections.length} collection(s)`);

    const result = await Promise.all(
      collections.map(async (col: any) => {
        try {
          const c = await chroma.getCollection({
            name: col.name,
            embeddingFunction: noopEmbeddingFunction,
          });
          const count = await c.count();
          return { name: col.name, id: col.id, count };
        } catch {
          return { name: col.name, id: col.id, count: "error" };
        }
      })
    );

    res.json({ collections: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /debug/chunks
 * Lists chunks stored in our collection
 *
 * Query params:
 *   ?limit=20          → max chunks to return (default: 20)
 *   ?file=doc.txt      → filter by filename
 *   ?q=RAG             → keyword search in chunk text
 *
 * Example response:
 *   {
 *     "collection": "aisde_docs",
 *     "totalCount": 47,
 *     "returned": 20,
 *     "chunks": [
 *       {
 *         "id": "company-kb.txt::0",
 *         "text": "RAG stands for Retrieval Augmented Generation...",
 *         "metadata": { "filename": "company-kb.txt", "strategy": "sentence-aware" },
 *         "preview": "RAG stands for Retrieval Augmented Gen..."
 *       }
 *     ],
 *     "uniqueFiles": ["company-kb.txt", "react-docs"]
 *   }
 */
router.get("/chunks", async (req: Request, res: Response) => {
  try {
    const limit    = Math.min(Number(req.query.limit ?? 80), 100);
    const fileFilter = req.query.file as string | undefined;
    const keyword    = req.query.q   as string | undefined;

    const col = await chroma.getOrCreateCollection({
      name: COLLECTION,
      embeddingFunction: noopEmbeddingFunction,
    });

    const totalCount = await col.count();
    console.log(`[debug] Collection "${COLLECTION}" has ${totalCount} chunks total`);

    if (totalCount === 0) {
      return res.json({
        collection: COLLECTION,
        totalCount: 0,
        returned: 0,
        chunks: [],
        uniqueFiles: [],
        message: "No chunks stored yet. Ingest a document first.",
      });
    }

    // Fetch all chunks (up to limit)
    // where filter: only return chunks from a specific file if ?file= is set
    const getParams: any = { limit };
    if (fileFilter) {
      getParams.where = { filename: fileFilter };
    }

    const result = await col.get(getParams);

    // Build chunk objects
    let chunks = (result.ids ?? []).map((id: string, i: number) => ({
      id,
      text:     result.documents?.[i] ?? "",
      metadata: result.metadatas?.[i] ?? {},
      // Short preview for easy scanning
      preview:  (result.documents?.[i] ?? "").slice(0, 120).replace(/\n/g, " ") + "...",
    }));

    // Keyword filter (client-side since Chroma doesn't support full-text search)
    if (keyword) {
      const kw = keyword.toLowerCase();
      chunks = chunks.filter((c) => c.text.toLowerCase().includes(kw));
      console.log(`[debug] Keyword filter "${keyword}" → ${chunks.length} matching chunks`);
    }

    // Collect unique filenames from metadata
    const uniqueFiles = [...new Set(
      (result.metadatas ?? []).map((m: any) => m?.filename ?? "unknown")
    )];

    console.log(`[debug] Returning ${chunks.length} chunks from ${uniqueFiles.length} file(s)`);

    res.json({
      collection:  COLLECTION,
      totalCount,
      returned:    chunks.length,
      filters:     { file: fileFilter ?? null, keyword: keyword ?? null },
      uniqueFiles,
      chunks,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
