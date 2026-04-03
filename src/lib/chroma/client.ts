/**
 * client.ts — Chroma vector database client
 *
 * WHAT IS CHROMA?
 * Chroma is a vector database — it stores text chunks alongside their
 * embedding vectors and lets you search by semantic similarity.
 *
 * THINK OF IT LIKE THIS:
 *   Regular DB:  SELECT * WHERE text LIKE '%RAG%'   ← keyword match
 *   Chroma:      query(embedding("What is RAG?"))   ← meaning match
 *
 * KEY CONCEPTS:
 *   Collection  — like a table in SQL, groups related documents together
 *   Document    — the raw text of a chunk
 *   Embedding   — the vector representation of that chunk
 *   Metadata    — extra info stored alongside (filename, author, etc.)
 *   ID          — unique identifier for each chunk (e.g. "rag-intro.txt::0")
 *
 * FLOW:
 *   Ingest:  chunk text → embed → upsertChunks() → stored in Chroma
 *   Query:   embed question → queryChunks() → top-k similar chunks returned
 */

import { ChromaClient } from "chromadb";

// Connect to Chroma running in Docker (localhost:8000 by default)
const chroma = new ChromaClient({
  host: process.env.CHROMA_HOST ?? "localhost",
  port: Number(process.env.CHROMA_PORT ?? 8000),
});

// All documents go into this single collection
// Think of it as the "table name" in Chroma
const COLLECTION = process.env.CHROMA_COLLECTION ?? "aisde_docs";

/**
 * A no-op embedding function passed to Chroma to suppress the
 * "DefaultEmbeddingFunction" warning.
 *
 * WHY THIS EXISTS:
 * Chroma's JS client always tries to attach a default local embedding
 * function when creating/getting a collection. If the package
 * @chroma-core/default-embed is not installed it prints a warning.
 *
 * We never use Chroma's built-in embedder — we embed with OpenAI
 * and pass vectors directly via upsert/query. So we provide a
 * dummy embedder that satisfies Chroma's interface and silences
 * the warning without changing any behaviour.
 */
const noopEmbeddingFunction = {
  generate: async (texts: string[]): Promise<number[][]> => {
    // Never called — we always pass pre-computed embeddings
    return texts.map(() => []);
  },
};

/**
 * Gets the collection, creating it if it doesn't exist yet
 * Called internally before every read/write operation
 */
async function getCollection() {
  // embeddingFunction: noopEmbeddingFunction tells Chroma we handle
  // embeddings ourselves — suppresses the DefaultEmbeddingFunction warning
  return chroma.getOrCreateCollection({
    name: COLLECTION,
    embeddingFunction: noopEmbeddingFunction,
  });
}

/**
 * Stores chunks + their embeddings into Chroma
 * Uses "upsert" — inserts new chunks, updates existing ones with the same ID
 *
 * @param ids        - Unique IDs for each chunk, e.g. ["rag-intro.txt::0", "rag-intro.txt::1"]
 * @param embeddings - Vectors for each chunk, e.g. [[0.12, -0.45, ...], [0.33, 0.21, ...]]
 * @param documents  - Raw text of each chunk, e.g. ["RAG stands for...", "Vector search..."]
 * @param metadatas  - Metadata for each chunk, e.g. [{ filename: "rag-intro.txt" }, ...]
 *
 * Example:
 *   await upsertChunks(
 *     ["doc.txt::0"],
 *     [[0.12, -0.45, ...]],
 *     ["RAG stands for Retrieval Augmented Generation"],
 *     [{ filename: "doc.txt", author: "admin" }]
 *   )
 */
export async function upsertChunks(
  ids: string[],
  embeddings: number[][],
  documents: string[],
  metadatas: Record<string, string>[]
) {
  const col = await getCollection();
  await col.upsert({ ids, embeddings, documents, metadatas });
}

/**
 * Finds the most semantically similar chunks to a query embedding
 *
 * @param embedding - Vector of the user's question (from embedText())
 * @param topK      - How many chunks to return (default: 5)
 * @returns         - The top-k most relevant chunks with their metadata and distances
 *
 * DISTANCE vs SCORE:
 *   Chroma returns "distance" — lower distance = more similar
 *   We convert to score = 1 - distance in retriever.ts (higher score = more relevant)
 *
 * Example:
 *   await queryChunks([0.12, -0.45, ...], 3)
 *   → {
 *       documents: ["RAG stands for...", "Vector search is...", "Embeddings are..."],
 *       metadatas: [{ filename: "rag-intro.txt" }, ...],
 *       distances: [0.08, 0.21, 0.35]   ← 0.08 is most similar
 *     }
 */
export async function queryChunks(
  embedding: number[],
  topK = 5
): Promise<{ documents: string[]; metadatas: Record<string, string>[]; distances: number[] }> {
  const col = await getCollection();

  // queryEmbeddings: we pass our query vector, Chroma finds nearest stored vectors
  const res = await col.query({ queryEmbeddings: [embedding], nResults: topK });

  // res.documents[0] — results for the first (and only) query embedding
  return {
    documents: (res.documents[0] ?? []) as string[],
    metadatas: (res.metadatas[0] ?? []) as Record<string, string>[],
    distances: (res.distances?.[0] ?? []) as number[],
  };
}
