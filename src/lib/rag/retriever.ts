/**
 * retriever.ts — Converts a user question into retrieved context + citations
 *
 * THIS IS THE CORE OF RAG:
 *   1. Take the user's question
 *   2. Embed it into a vector
 *   3. Find the most similar chunks in Chroma
 *   4. Format them as "context" to inject into the LLM prompt
 *   5. Return citations so the user knows which document each answer came from
 *
 * FULL RAG FLOW:
 *   User: "What is RAG?"
 *     ↓
 *   embedText("What is RAG?") → [0.12, -0.45, ...]
 *     ↓
 *   queryChunks([0.12, -0.45, ...], topK=5) → top 5 matching chunks from Chroma
 *     ↓
 *   Build context string:
 *     "[1] (rag-intro.txt): RAG stands for Retrieval Augmented Generation..."
 *     "[2] (rag-intro.txt): It combines vector search with LLMs..."
 *     ↓
 *   LLM receives context + question → generates grounded answer
 *     ↓
 *   Response includes citations pointing back to source chunks
 *
 * PHASE 5 CHANGES:
 *   - Added structured logging via log() for every retrieval
 *   - Logs: query, chunksFound, topScore, avgScore, latencyMs
 *   - These feed into /eval dashboard metrics
 *   - Old console.logs kept
 */

import { embedText } from "../embeddings/openai";
import { queryChunks } from "../chroma/client";
import { Citation } from "../schemas/answer";
import { log } from "../observability/logger";

export interface RetrievalResult {
  context: string;       // formatted string injected into the LLM system prompt
  citations: Citation[]; // list of source chunks returned to the client
}

/**
 * Retrieves the most relevant chunks for a given question
 *
 * @param question - The user's raw question string
 * @param topK     - Number of chunks to retrieve (default: 5)
 * @returns        - Formatted context string + citation objects
 *
 * Example output:
 *   {
 *     context: "[1] (rag-intro.txt): RAG stands for...\n\n[2] (rag-intro.txt): It combines...",
 *     citations: [
 *       { source: "rag-intro.txt", chunk: "RAG stands for...", score: 0.92 },
 *       { source: "rag-intro.txt", chunk: "It combines...",    score: 0.87 }
 *     ]
 *   }
 */
export async function retrieve(question: string, topK = 5): Promise<RetrievalResult> {
  const start = Date.now();

  // Step 1: Convert the question to a vector so we can search by meaning
  console.log("Question", question);
  const embedding = await embedText(question);

  // Step 2: Find the topK most similar chunks stored in Chroma
  const { documents, metadatas, distances } = await queryChunks(embedding, topK);
  console.log("Result of retrieve query", documents, metadatas, distances);

  // Step 3: Build citation objects for each retrieved chunk
  // score = 1 - distance (Chroma uses distance, we convert to similarity score)
  // distance 0.08 → score 0.92 (very relevant)
  // distance 0.50 → score 0.50 (somewhat relevant)
  const citations: Citation[] = documents.map((chunk, i) => ({
    source: metadatas[i]?.filename ?? "unknown",
    chunk,
    score: distances[i] !== undefined ? 1 - distances[i] : undefined,
  }));

  // Step 4: Format chunks as numbered context for the LLM prompt
  // The [1], [2] numbering helps the LLM reference specific sources in its answer
  const context = documents
    .map((doc, i) => `[${i + 1}] (${metadatas[i]?.filename ?? "unknown"}): ${doc}`)
    .join("\n\n");

  console.log("FINAL CONTEXT and citation", context, citations);

  // ── Phase 5: Structured log ───────────────────────────────────
  // Compute scores for metrics — filter out undefined scores first
  const scores = citations.map((c) => c.score ?? 0);
  const topScore = scores.length ? Math.max(...scores) : 0;
  const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  log({
    phase: "retrieval",
    query: question,
    chunksFound: citations.length,
    topScore,
    avgScore,
    latencyMs: Date.now() - start,
  });

  return { context, citations };
}
