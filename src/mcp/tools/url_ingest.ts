/**
 * url_ingest.ts — MCP Tool: url_ingest
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHAT DOES THIS TOOL DO?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Combines url_fetch + rag_ingest into a single tool call.
 * This is the "power tool" — one call ingests an entire webpage.
 *
 * PIPELINE:
 *   url
 *     ↓
 *   handleUrlFetch()   → fetch HTML → strip to clean text
 *     ↓
 *   handleRagIngest()  → chunk → embed → store in Chroma
 *     ↓
 *   { success, chunksStored, filename, title }
 *
 * WHY A COMBINED TOOL?
 *   Without it, an agent needs 2 tool calls:
 *     1. url_fetch(url)           → get text
 *     2. rag_ingest(text, name)   → store text
 *
 *   With url_ingest, it's 1 tool call:
 *     1. url_ingest(url)          → fetch + store ✅
 *
 *   Fewer tool calls = faster responses + lower token cost.
 *   This is a key MCP design principle: compose tools for common workflows.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * EXAMPLE USAGE:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * From Cursor chat:
 *   "Ingest the React hooks documentation"
 *   → Cursor calls url_ingest({ url: "https://react.dev/reference/react" })
 *   → Page fetched, chunked, embedded, stored in Chroma
 *   → "Now ask me anything about React hooks" ✅
 *
 * From our agent (orchestrator decides to ingest a URL):
 *   await ingestUrl("https://docs.example.com/api")
 *   → Same pipeline, called programmatically
 */

import { handleUrlFetch } from "./url_fetch";
import { handleRagIngest } from "./rag_ingest";

export const urlIngestTool = {
  name: "url_ingest",
  description:
    "Fetches a URL and ingests its content into the RAG knowledge base in one step. " +
    "Use this to add web pages, documentation, or articles to the knowledge base. " +
    "The page will be fetched, cleaned, chunked, embedded, and stored automatically.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch and ingest (must start with http:// or https://)",
      },
      filename: {
        type: "string",
        description:
          "Optional custom name for this document in Chroma. " +
          "If not provided, the page title is used automatically.",
      },
      metadata: {
        type: "object",
        description: "Optional key-value metadata (e.g. { source: 'web', topic: 'react' })",
        additionalProperties: { type: "string" },
      },
    },
    required: ["url"],
  },
};

/**
 * Handles a url_ingest tool call
 *
 * @param args - { url, filename?, metadata? }
 * @returns    - MCP content array with { success, chunksStored, filename, title, url }
 *
 * Example:
 *   handleUrlIngest({ url: "https://react.dev/learn" })
 *   → {
 *       success: true,
 *       chunksStored: 14,
 *       filename: "react.dev-learn",
 *       title: "Quick Start – React",
 *       url: "https://react.dev/learn"
 *     }
 */
export async function handleUrlIngest(args: {
  url: string;
  filename?: string;
  metadata?: Record<string, string>;
}) {
  const { url, metadata = {} } = args;

  console.log(`\n${"-".repeat(50)}`);
  console.log(`[url_ingest] 🚀 START — fetch + ingest pipeline`);
  console.log(`[url_ingest] URL: ${url}`);

  console.log(`[url_ingest] 🌐 STEP 1 — Calling url_fetch...`);
  const fetchResponse = await handleUrlFetch({ url });
  const fetchResult = JSON.parse(
    (fetchResponse.content[0] as { type: string; text: string }).text
  ) as { url: string; title: string; text: string; charCount: number };

  console.log(`[url_ingest] ✅ Fetch done: "${fetchResult.title}" (${fetchResult.charCount} chars)`);

  const derivedFilename =
    args.filename ??
    url
      .replace(/^https?:\/\//, "")
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9.-]/g, "")
      .slice(0, 80);

  console.log(`[url_ingest] 💾 STEP 2 — Ingesting as "${derivedFilename}"...`);

  const ingestResponse = await handleRagIngest({
    content: fetchResult.text,
    filename: derivedFilename,
    metadata: {
      ...metadata,
      sourceUrl: url,
      pageTitle: fetchResult.title,
      ingestedAt: new Date().toISOString(),
    },
  });

  const ingestResult = JSON.parse(
    (ingestResponse.content[0] as { type: string; text: string }).text
  ) as { success: boolean; chunksStored: number; filename: string };

  console.log(`[url_ingest] ✅ Ingest done: ${ingestResult.chunksStored} chunks stored`);
  console.log(`[url_ingest] 🏁 COMPLETE — "${derivedFilename}" is now searchable in Chroma`);
  console.log(`${"-".repeat(50)}\n`);

  const result = {
    success: true,
    chunksStored: ingestResult.chunksStored,
    filename: derivedFilename,
    title: fetchResult.title,
    url,
  };

  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}
