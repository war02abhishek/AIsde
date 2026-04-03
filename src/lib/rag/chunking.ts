/**
 * chunking.ts — Document chunking strategies
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PHASE 1 vs PHASE 5 — WHY WE CHANGED STRATEGY
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * PHASE 1 — Fixed-size chunking (commented out below):
 *   Split every 500 characters regardless of sentence boundaries.
 *   Problem: "RAG stands for Retrieval Augmented Gen" ← chunk ends mid-word
 *            "eration. It combines vector search..."  ← next chunk starts mid-sentence
 *   Result:  Embeddings represent incomplete thoughts → poor retrieval accuracy
 *
 * PHASE 5 — Sentence-aware chunking (active below):
 *   Split on sentence boundaries, group sentences until target size is reached.
 *   Result:  Every chunk is a complete thought → better embeddings → better retrieval
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * THREE CHUNKING STRATEGIES (from simple to advanced):
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. Fixed-size (Phase 1 — commented out):
 *    Split every N chars. Fast but splits mid-sentence.
 *    Best for: quick prototypes, uniform text (logs, CSV)
 *
 * 2. Sentence-aware (Phase 5 — active):
 *    Split on sentence endings (. ! ?), group into target size.
 *    Best for: prose documents, articles, knowledge bases
 *
 * 3. Semantic chunking (future):
 *    Use an LLM to find natural topic boundaries.
 *    Best for: complex documents with mixed topics
 *    Cost: 1 LLM call per document (expensive at scale)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SENTENCE-AWARE CHUNKING EXAMPLE:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Input text (3 sentences):
 *   "RAG stands for Retrieval Augmented Generation.
 *    It combines vector search with LLMs.
 *    This makes answers more accurate."
 *
 * TARGET_CHUNK_CHARS = 120, OVERLAP_SENTENCES = 1
 *
 * Chunk 0: "RAG stands for Retrieval Augmented Generation. It combines vector search with LLMs."
 *           ↑ grouped until ~120 chars
 *
 * Chunk 1: "It combines vector search with LLMs. This makes answers more accurate."
 *           ↑ starts with last sentence of chunk 0 (overlap) for context continuity
 */

export interface Chunk {
  text: string;
  index: number;
  filename: string;
  metadata: Record<string, string>;
  // Phase 5 addition: track which strategy produced this chunk
  // Useful for eval — compare retrieval scores across strategies
  strategy: "fixed-size" | "sentence-aware";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 5: SENTENCE-AWARE CHUNKING (ACTIVE)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Target size in characters per chunk (~150-200 words)
// Smaller = more precise retrieval, larger = more context per chunk
const TARGET_CHUNK_CHARS = 600;

// How many sentences to carry over into the next chunk as overlap
// Overlap = 1 means the last sentence of chunk N becomes the first of chunk N+1
// This preserves context at chunk boundaries (same idea as char overlap in Phase 1)
const OVERLAP_SENTENCES = 1;

/**
 * Splits text into sentences using punctuation boundaries
 * Handles: periods, exclamation marks, question marks
 * Preserves: the punctuation at the end of each sentence
 *
 * @param text - Raw document text
 * @returns    - Array of sentence strings
 *
 * Example:
 *   splitIntoSentences("RAG stands for retrieval. It combines LLMs. Great tool!")
 *   → ["RAG stands for retrieval.", "It combines LLMs.", "Great tool!"]
 */
function splitIntoSentences(text: string): string[] {
  // Regex explanation:
  //   [.!?]     — sentence-ending punctuation
  //   (\s+|$)   — followed by whitespace or end of string
  // We split on these boundaries but keep the punctuation (positive lookbehind)
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Sentence-aware chunking — groups sentences into chunks of ~TARGET_CHUNK_CHARS
 * with OVERLAP_SENTENCES sentences carried over between chunks
 *
 * @param text     - Full document content
 * @param filename - Source document name
 * @param metadata - Optional extra key-value pairs
 * @returns        - Array of Chunk objects with strategy="sentence-aware"
 *
 * Algorithm:
 *   1. Split text into sentences
 *   2. Accumulate sentences until chunk reaches TARGET_CHUNK_CHARS
 *   3. Save chunk, carry last OVERLAP_SENTENCES into next chunk
 *   4. Repeat until all sentences are processed
 */
export function chunkText(
  text: string,
  filename: string,
  metadata: Record<string, string> = {}
): Chunk[] {
  const sentences = splitIntoSentences(text);
  const chunks: Chunk[] = [];
  let i = 0;
  let index = 0;

  while (i < sentences.length) {
    const currentSentences: string[] = [];
    let currentLength = 0;

    // Accumulate sentences until we hit the target chunk size
    while (i < sentences.length && currentLength < TARGET_CHUNK_CHARS) {
      currentSentences.push(sentences[i]);
      currentLength += sentences[i].length + 1; // +1 for space
      i++;
    }

    const chunkText = currentSentences.join(" ");
    chunks.push({
      text: chunkText,
      index,
      filename,
      metadata,
      strategy: "sentence-aware",
    });

    // Carry last OVERLAP_SENTENCES back so next chunk starts with them
    // This is the sentence-level equivalent of char overlap in Phase 1
    if (OVERLAP_SENTENCES > 0 && i < sentences.length) {
      i -= OVERLAP_SENTENCES;
    }

    index++;
  }

  console.log(`[chunking] "${filename}" → ${chunks.length} sentence-aware chunks (strategy: sentence-aware)`);
  return chunks;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 1: FIXED-SIZE CHUNKING (COMMENTED OUT — kept for learning)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Compare this with the sentence-aware version above.
// Key difference: this splits blindly every 500 chars regardless of
// sentence boundaries. The sentence-aware version above respects meaning.
//
// To switch back: comment out chunkText above, uncomment this block.
//
// const CHUNK_SIZE = 500;
// const CHUNK_OVERLAP = 50;
//
// export function chunkText(
//   text: string,
//   filename: string,
//   metadata: Record<string, string> = {}
// ): Chunk[] {
//   const chunks: Chunk[] = [];
//   let i = 0;
//   let index = 0;
//
//   while (i < text.length) {
//     const chunk = text.slice(i, i + CHUNK_SIZE);
//     chunks.push({ text: chunk, index, filename, metadata, strategy: "fixed-size" });
//     i += CHUNK_SIZE - CHUNK_OVERLAP;
//     index++;
//   }
//
//   console.log(`[chunking] "${filename}" → ${chunks.length} fixed-size chunks`);
//   return chunks;
// }
