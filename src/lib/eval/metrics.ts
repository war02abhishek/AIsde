/**
 * metrics.ts — Evaluation dataset + metrics runner
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHY EVALUATION?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Without eval you say: "I think retrieval improved"
 * With eval you say:    "Retrieval recall@3 went from 0.42 → 0.71
 *                        after switching to sentence-aware chunking"
 *
 * Eval = a fixed dataset of questions + expected answers
 *        run against your pipeline → produces measurable scores
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * THREE METRICS WE MEASURE:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. Retrieval Recall@k
 *    "Did the correct chunk appear in the top-k results?"
 *    Score: 0.0 (never retrieved) → 1.0 (always retrieved)
 *    How: check if expectedKeyword appears in any of the top-k chunks
 *
 * 2. Answer Relevance
 *    "Does the answer actually address the question?"
 *    Score: 0.0 → 1.0
 *    How: check if expectedKeywords appear in the answer
 *
 * 3. Latency
 *    "How long did each question take?"
 *    Used to detect performance regressions
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PRODUCTION EQUIVALENT:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * RAGAS (Python library) — industry standard RAG evaluation
 *   Metrics: faithfulness, answer relevancy, context precision, recall
 *   We implement a simplified version of the same concepts here
 *
 * LangSmith — LangChain's evaluation platform
 *   Run datasets, compare runs, track regressions
 *   Our /eval endpoint is a simplified version of this
 */

import { retrieve } from "../rag/retriever";
import { generate } from "../rag/generator";

// ── Evaluation Dataset ────────────────────────────────────────────
// Each entry: question + keywords that MUST appear in retrieved chunks
// and keywords that MUST appear in the answer
// Based on the company-kb.txt document we use for testing
export interface EvalCase {
  id: string;
  question: string;
  // At least one of these keywords must appear in retrieved chunks
  expectedChunkKeywords: string[];
  // At least one of these keywords must appear in the answer
  expectedAnswerKeywords: string[];
}

export const EVAL_DATASET: EvalCase[] = [
  {
    id: "rag-definition",
    question: "What does RAG stand for?",
    expectedChunkKeywords: ["Retrieval Augmented Generation", "RAG stands for"],
    expectedAnswerKeywords: ["Retrieval Augmented Generation", "retrieval"],
  },
  {
    id: "chunking-strategy",
    question: "What chunking strategy does the system use?",
    expectedChunkKeywords: ["chunking", "500 characters", "sentence"],
    expectedAnswerKeywords: ["chunk", "sentence", "500"],
  },
  {
    id: "embedding-model",
    question: "Which embedding model is used?",
    expectedChunkKeywords: ["text-embedding-3-small", "embedding"],
    expectedAnswerKeywords: ["text-embedding-3-small", "OpenAI"],
  },
  {
    id: "vector-db",
    question: "What vector database does the system use?",
    expectedChunkKeywords: ["Chroma", "vector database"],
    expectedAnswerKeywords: ["Chroma"],
  },
  {
    id: "critic-score",
    question: "What score does the critic agent need to pass?",
    expectedChunkKeywords: ["score", "7", "faithfulness"],
    expectedAnswerKeywords: ["7", "score", "pass"],
  },
  {
    id: "annual-leave",
    question: "How many days of annual leave do employees get?",
    expectedChunkKeywords: ["25 days", "annual leave"],
    expectedAnswerKeywords: ["25"],
  },
  {
    id: "session-memory",
    question: "How does session memory work?",
    expectedChunkKeywords: ["sessionId", "summary", "turns"],
    expectedAnswerKeywords: ["session", "memory", "summary"],
  },
  {
    id: "tech-stack",
    question: "What is the tech stack of the system?",
    expectedChunkKeywords: ["Node.js", "TypeScript", "Express", "React"],
    expectedAnswerKeywords: ["Node", "TypeScript", "React"],
  },
];

// ── Result types ──────────────────────────────────────────────────
export interface EvalResult {
  id: string;
  question: string;
  retrievalRecall: number;   // 1.0 = keyword found in chunks, 0.0 = not found
  answerRelevance: number;   // 1.0 = keyword found in answer, 0.0 = not found
  latencyMs: number;
  answer: string;            // actual answer generated
  topChunkScore: number;     // highest similarity score from retrieval
}

export interface EvalSummary {
  avgRetrievalRecall: number;
  avgAnswerRelevance: number;
  avgLatencyMs: number;
  avgTopChunkScore: number;
  results: EvalResult[];
  ranAt: string;
}

/**
 * Runs the full eval dataset through the pipeline and returns metrics
 *
 * @returns EvalSummary with per-question results + aggregate scores
 *
 * Example output:
 *   {
 *     avgRetrievalRecall: 0.875,   ← 7/8 questions retrieved correct chunk
 *     avgAnswerRelevance: 0.750,   ← 6/8 answers contained expected keywords
 *     avgLatencyMs: 1240,
 *     avgTopChunkScore: 0.82,
 *     results: [...]
 *   }
 */
export async function runEval(): Promise<EvalSummary> {
  console.log(`[eval] Starting eval run with ${EVAL_DATASET.length} questions...`);
  const results: EvalResult[] = [];

  for (const evalCase of EVAL_DATASET) {
    const start = Date.now();
    console.log(`[eval] Running: "${evalCase.question}"`);

    try {
      // Step 1: Retrieve chunks for this question
      const { citations, context } = await retrieve(evalCase.question);

      // Step 2: Generate answer
      const { answer } = await generate(evalCase.question, context);

      const latencyMs = Date.now() - start;

      // ── Metric 1: Retrieval Recall ──────────────────────────────
      // Check if any expected keyword appears in any retrieved chunk
      // Case-insensitive match
      const allChunkText = citations.map((c) => c.chunk.toLowerCase()).join(" ");
      const retrievalHit = evalCase.expectedChunkKeywords.some((kw) =>
        allChunkText.includes(kw.toLowerCase())
      );

      // ── Metric 2: Answer Relevance ──────────────────────────────
      // Check if any expected keyword appears in the answer
      const answerLower = answer.toLowerCase();
      const answerHit = evalCase.expectedAnswerKeywords.some((kw) =>
        answerLower.includes(kw.toLowerCase())
      );

      // ── Metric 3: Top chunk similarity score ────────────────────
      const topChunkScore = citations.length
        ? Math.max(...citations.map((c) => c.score ?? 0))
        : 0;

      results.push({
        id: evalCase.id,
        question: evalCase.question,
        retrievalRecall: retrievalHit ? 1.0 : 0.0,
        answerRelevance: answerHit ? 1.0 : 0.0,
        latencyMs,
        answer,
        topChunkScore,
      });

      console.log(`[eval] "${evalCase.id}" recall=${retrievalHit ? 1 : 0} relevance=${answerHit ? 1 : 0} latency=${latencyMs}ms`);

    } catch (err: any) {
      console.error(`[eval] Failed on "${evalCase.id}": ${err.message}`);
      results.push({
        id: evalCase.id,
        question: evalCase.question,
        retrievalRecall: 0,
        answerRelevance: 0,
        latencyMs: Date.now() - start,
        answer: `ERROR: ${err.message}`,
        topChunkScore: 0,
      });
    }
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const summary: EvalSummary = {
    avgRetrievalRecall: avg(results.map((r) => r.retrievalRecall)),
    avgAnswerRelevance: avg(results.map((r) => r.answerRelevance)),
    avgLatencyMs:       avg(results.map((r) => r.latencyMs)),
    avgTopChunkScore:   avg(results.map((r) => r.topChunkScore)),
    results,
    ranAt: new Date().toISOString(),
  };

  console.log(`[eval] Done. recall=${summary.avgRetrievalRecall.toFixed(2)} relevance=${summary.avgAnswerRelevance.toFixed(2)} latency=${summary.avgLatencyMs.toFixed(0)}ms`);
  return summary;
}
