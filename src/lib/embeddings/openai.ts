/**
 * openai.ts — Converts text into embedding vectors using OpenAI
 *
 * WHAT IS AN EMBEDDING?
 * An embedding is a list of numbers (a vector) that represents the "meaning"
 * of a piece of text in a high-dimensional space.
 *
 * Texts with similar meaning have vectors that are close together.
 * This is how we do semantic search — instead of matching keywords,
 * we match meaning.
 *
 * EXAMPLE:
 *   "What is RAG?"          → [0.12, -0.45, 0.87, ...] (1536 numbers)
 *   "RAG means Retrieval.." → [0.11, -0.44, 0.85, ...] (very similar vector)
 *   "I like pizza"          → [0.91,  0.23, -0.12, ...] (very different vector)
 *
 * MODEL: text-embedding-3-small
 *   - Outputs 1536-dimensional vectors
 *   - Fast and cheap (~$0.00002 per 1K tokens)
 *   - Good enough for most RAG use cases
 *
 * FLOW:
 *   text → OpenAI API → embedding vector → stored in Chroma
 *   query → OpenAI API → query vector → compared against stored vectors
 */

import OpenAI from "openai";

// OpenAI client — reads OPENAI_API_KEY from environment automatically
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = "text-embedding-3-small";

/**
 * Embeds a single text string into a vector
 * Used at query time to embed the user's question
 *
 * @param text - Any string to embed
 * @returns    - Array of numbers representing the text's meaning
 *
 * Example:
 *   await embedText("What is RAG?")
 *   → [0.12, -0.45, 0.87, ...] (1536 numbers)
 */
export async function embedText(text: string): Promise<number[]> {
  const res = await client.embeddings.create({ model: MODEL, input: text });
  return res.data[0].embedding;
}

/**
 * Embeds multiple texts in a single API call (more efficient than calling embedText in a loop)
 * Used at ingestion time to embed all chunks of a document at once
 *
 * @param texts - Array of strings to embed
 * @returns     - Array of vectors, one per input text (same order)
 *
 * Example:
 *   await embedBatch(["RAG stands for...", "Vector search is..."])
 *   → [[0.12, -0.45, ...], [0.33, 0.21, ...]]
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await client.embeddings.create({ model: MODEL, input: texts });
  // res.data is sorted by index, so order matches input texts
  return res.data.map((d) => d.embedding);
}
