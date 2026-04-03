/**
 * generator.ts — Calls the LLM and enforces structured JSON output via Zod
 *
 * WHY STRUCTURED OUTPUT?
 * By default, LLMs return plain text. We need a reliable JSON shape so the
 * UI can render citations, follow-up chips, etc. without guessing.
 *
 * HOW IT WORKS:
 *   1. Tell the LLM to respond ONLY in a specific JSON format (via system prompt)
 *   2. Parse the response with Zod
 *   3. If parsing fails (LLM hallucinated wrong JSON), retry up to MAX_RETRIES times
 *   4. If all retries fail, throw a clear error
 *
 * EXAMPLE LLM OUTPUT WE EXPECT:
 *   {
 *     "answer": "RAG stands for Retrieval Augmented Generation...",
 *     "followUpQuestions": [
 *       "How does chunking work?",
 *       "What is a vector database?",
 *       "How are embeddings created?"
 *     ]
 *   }
 *
 * NOTE: citations come from Chroma retrieval (not from the LLM) — the LLM
 * only generates the answer text and follow-up questions.
 *
 * PHASE 3 CHANGES:
 *   - Added memory param — injected into system prompt for conversation continuity
 *
 * PHASE 5 CHANGES:
 *   - Added structured logging via log() after each successful generation
 *   - Logs: attempts, latencyMs, promptTokens, completionTokens, estimatedCostUsd
 *   - gpt-4o-mini pricing: $0.15/1M prompt tokens, $0.60/1M completion tokens
 *   - Old console.logs kept
 */

import OpenAI from "openai";
import { z } from "zod";
import { log } from "../observability/logger";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_RETRIES = 3;

/**
 * Zod schema for what we expect the LLM to return as JSON
 * This is validated on every attempt — if it fails, we retry
 */
const LLMOutputSchema = z.object({
  answer: z.string().min(1),
  followUpQuestions: z.array(z.string()).max(3), // ask LLM for max 3 follow-ups
});

type LLMOutput = z.infer<typeof LLMOutputSchema>;

/**
 * Builds the system prompt that instructs the LLM to:
 *   1. Use conversation memory for context continuity across turns
 *   2. Answer only from the provided retrieved context
 *   3. Return a strict JSON object (no markdown, no extra text)
 *
 * @param context - Retrieved chunks formatted as numbered list
 * @param memory  - Formatted conversation memory from summarizer (empty on first turn)
 *
 * PROMPT STRUCTURE:
 *   [Memory section]     ← injected only if memory exists (Phase 3)
 *   [Retrieved context]  ← always present (from Chroma)
 *   [JSON format rules]  ← always present
 */
function buildSystemPrompt(context: string, memory: string): string {
  const memorySection = memory ? `${memory}\n\n` : "";
  return `You are a helpful assistant. Answer using ONLY the context below.
If the context doesn't contain the answer, set answer to "I don't have enough information."

${memorySection}You MUST respond with ONLY a valid JSON object in this exact format (no markdown, no extra text):
{
  "answer": "<your answer here>",
  "followUpQuestions": ["<question 1>", "<question 2>", "<question 3>"]
}

Generate up to 3 follow-up questions the user might ask next, based on the context.

=== Retrieved Context ===
${context}`;
}

/**
 * Calls the LLM with structured output enforcement and retries on invalid JSON
 *
 * @param question - The user's question
 * @param context  - Retrieved context from Chroma (injected into system prompt)
 * @param memory   - Formatted conversation memory string (empty string on first turn)
 * @returns        - Validated { answer, followUpQuestions }
 *
 * Retry flow example:
 *   Attempt 1: LLM returns "Sure! Here is the answer: {...}" → Zod fails (not pure JSON) → retry
 *   Attempt 2: LLM returns { "answer": "...", "followUpQuestions": [...] } → Zod passes → return
 */
export async function generate(question: string, context: string, memory = ""): Promise<LLMOutput> {
  let lastError: Error = new Error("Generation failed");
  const start = Date.now();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        // response_format forces the model to output valid JSON
        // This reduces (but doesn't eliminate) malformed JSON responses
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(context, memory) },
          { role: "user", content: question },
        ],
      });

      console.log("response from openai completion", completion);
      const raw = completion.choices[0].message.content ?? "";

      // Parse the raw JSON string into a JS object
      const parsed = JSON.parse(raw);
      console.log("Parsed response", parsed);

      // Validate the shape with Zod — throws if fields are missing or wrong type
      const validated = LLMOutputSchema.parse(parsed);
      console.log("zodded parsed response", validated);

      // ── Phase 5: Structured log ─────────────────────────────────
      // gpt-4o-mini pricing (as of 2024):
      //   prompt tokens:     $0.15  per 1M tokens = $0.00000015 per token
      //   completion tokens: $0.60  per 1M tokens = $0.0000006  per token
      const usage = completion.usage;
      const promptTokens     = usage?.prompt_tokens     ?? 0;
      const completionTokens = usage?.completion_tokens ?? 0;
      const estimatedCostUsd = (promptTokens * 0.00000015) + (completionTokens * 0.0000006);

      log({
        phase: "generate",
        question: question.slice(0, 100),
        attempts: attempt,
        latencyMs: Date.now() - start,
        promptTokens,
        completionTokens,
        estimatedCostUsd,
      });

      return validated;
    } catch (err: any) {
      lastError = err;
      console.warn(`[generator] Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
    }
  }

  throw new Error(`LLM generation failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
}
