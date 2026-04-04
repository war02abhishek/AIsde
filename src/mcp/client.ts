/**
 * client.ts — MCP Client for our agents
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHY A CLIENT WRAPPER?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * The MCP SDK's Client class handles the protocol.
 * This wrapper adds:
 *   1. Typed helper methods (searchDocs, ingestDoc)
 *      so agents don't need to know MCP protocol details
 *   2. Singleton pattern — one client instance shared across agents
 *   3. Lazy connection — connects on first use, not at import time
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * IN-PROCESS vs OUT-OF-PROCESS:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Our MCP server runs in the SAME Node.js process as our Express server.
 * So instead of spawning a child process, we use an in-process transport
 * that connects client ↔ server directly in memory.
 *
 * IN-PROCESS (what we use):
 *   Client ──(in-memory)──▶ Server
 *   Fast, no serialization overhead, same process
 *   Used when: client and server are in the same codebase
 *
 * OUT-OF-PROCESS (what Cursor/Claude uses):
 *   Cursor ──(stdio)──▶ Our MCP server process
 *   Separate processes, JSON-RPC over stdin/stdout
 *   Used when: external client connects to our server
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PHASE 4 vs PHASE 6 — WHAT CHANGES IN AGENTS:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Phase 4 retrieval agent:
 *   import { retrieve } from "../rag/retriever";        // direct import
 *   const result = await retrieve(query);               // direct call
 *
 * Phase 6 retrieval agent:
 *   import { mcpClient } from "../mcp/client";          // MCP client
 *   const result = await mcpClient.searchDocs(query);   // MCP tool call
 *
 * The result is identical — but now the retrieval logic is behind
 * a standard protocol that ANY client can use.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleRagSearch } from "./tools/rag_search";
import { handleRagIngest } from "./tools/rag_ingest";
import { handleUrlFetch } from "./tools/url_fetch";
import { handleUrlIngest } from "./tools/url_ingest";

// ── Singleton pattern ─────────────────────────────────────────────
// One client instance shared across all agents
// Lazy initialized on first call to getClient()
let clientInstance: Client | null = null;

/**
 * Returns the shared MCP client, creating and connecting it if needed
 * Uses in-process transport — no child process spawning needed
 *
 * SINGLETON PATTERN:
 *   First call  → creates client + server + connects them
 *   Later calls → returns the already-connected client
 */
async function getClient(): Promise<Client> {
  if (clientInstance) return clientInstance;

  // Create an in-process MCP server (same tools as server.ts)
  // This avoids spawning a child process when agents call tools internally
  const inProcessServer = new McpServer({
    name: "aisde-rag-server-inprocess",
    version: "1.0.0",
  });

  // Register the same tools as server.ts using registerTool (SDK v1.29.0+)
  inProcessServer.registerTool(
    "rag_search",
    {
      description: "Search the RAG knowledge base for relevant document chunks.",
      inputSchema: {
        query: z.string().min(1),
        topK:  z.number().min(1).max(10).optional().default(5),
      },
    },
    async ({ query, topK }) => handleRagSearch({ query, topK })
  );

  inProcessServer.registerTool(
    "rag_ingest",
    {
      description: "Ingest a document into the RAG knowledge base.",
      inputSchema: {
        content:  z.string().min(1),
        filename: z.string().min(1),
        metadata: z.record(z.string()).optional(),
      },
    },
    async ({ content, filename, metadata }) => handleRagIngest({ content, filename, metadata })
  );

  // ── url_fetch: fetch a URL and return clean text ──────────────
  inProcessServer.registerTool(
    "url_fetch",
    {
      description: "Fetches a URL and returns clean readable text content.",
      inputSchema: {
        url:      z.string().min(1),
        maxChars: z.number().optional().default(15000),
      },
    },
    async ({ url, maxChars }) => handleUrlFetch({ url, maxChars })
  );

  // ── url_ingest: fetch + ingest in one call ────────────────────
  inProcessServer.registerTool(
    "url_ingest",
    {
      description: "Fetches a URL and ingests its content into the RAG knowledge base.",
      inputSchema: {
        url:      z.string().min(1),
        filename: z.string().optional(),
        metadata: z.record(z.string()).optional(),
      },
    },
    async ({ url, filename, metadata }) => handleUrlIngest({ url, filename, metadata })
  );

  // InMemoryTransport creates a linked pair of transports
  // [clientTransport] ←→ [serverTransport] — in memory, no network
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Connect server to its transport
  await inProcessServer.connect(serverTransport);

  // Create and connect the client
  const client = new Client({ name: "aisde-agent-client", version: "1.0.0" });
  await client.connect(clientTransport);

  clientInstance = client;
  console.log("[mcp:client] In-process MCP client connected");
  return client;
}

// ── Typed helper methods ──────────────────────────────────────────
// These wrap the raw MCP callTool() with typed inputs/outputs
// Agents use these instead of raw protocol calls

/**
 * Searches the RAG knowledge base via MCP tool call
 *
 * PHASE 4 equivalent (direct call):
 *   const { citations } = await retrieve(query, topK);
 *
 * PHASE 6 (MCP call — what this function does):
 *   const result = await client.callTool("rag_search", { query, topK });
 *
 * @param query - Search query string
 * @param topK  - Number of chunks to return (default: 5)
 * @returns     - { chunks: string[], citations: [...] }
 */
export async function searchDocs(query: string, topK = 5) {
  const client = await getClient();

  console.log(`[mcp:client] Calling rag_search: "${query}"`);

  const response = await client.callTool({
    name: "rag_search",
    arguments: { query, topK },
  });

  // Parse the JSON text response from the MCP tool
  const text = (response.content as any[])[0]?.text ?? "{}";
  return JSON.parse(text) as {
    chunks: string[];
    citations: Array<{ source: string; score?: number; preview: string }>;
  };
}

/**
 * Ingests a document into Chroma via MCP tool call
 *
 * PHASE 4 equivalent (direct call):
 *   await upsertChunks(ids, embeddings, texts, metadatas);
 *
 * PHASE 6 (MCP call):
 *   await ingestDoc(content, filename);
 *
 * @param content  - Full document text
 * @param filename - Document name
 * @param metadata - Optional key-value metadata
 * @returns        - { success, chunksStored, filename }
 */
export async function ingestDoc(
  content: string,
  filename: string,
  metadata?: Record<string, string>
) {
  const client = await getClient();

  console.log(`[mcp:client] Calling rag_ingest: "${filename}"`);

  const response = await client.callTool({
    name: "rag_ingest",
    arguments: { content, filename, metadata },
  });

  const text = (response.content as any[])[0]?.text ?? "{}";
  return JSON.parse(text) as {
    success: boolean;
    chunksStored: number;
    filename: string;
  };
}

/**
 * Fetches a URL and returns clean text via MCP url_fetch tool
 *
 * @param url      - URL to fetch
 * @param maxChars - Max characters to return (default: 15000)
 * @returns        - { url, title, text, charCount }
 */
export async function fetchUrl(url: string, maxChars = 15000) {
  const client = await getClient();

  console.log(`[mcp:client] Calling url_fetch: "${url}"`);

  const response = await client.callTool({
    name: "url_fetch",
    arguments: { url, maxChars },
  });

  const text = (response.content as any[])[0]?.text ?? "{}";
  return JSON.parse(text) as {
    url: string;
    title: string;
    text: string;
    charCount: number;
  };
}

/**
 * Fetches a URL and ingests it into Chroma in one call via MCP url_ingest tool
 *
 * This is the most useful method for adding web content to the knowledge base.
 * Combines fetchUrl() + ingestDoc() into a single MCP tool call.
 *
 * @param url      - URL to fetch and ingest
 * @param filename - Optional custom document name (derived from URL if not provided)
 * @param metadata - Optional key-value metadata
 * @returns        - { success, chunksStored, filename, title, url }
 *
 * Example:
 *   await ingestUrl("https://react.dev/learn")
 *   → { success: true, chunksStored: 14, filename: "react.dev-learn",
 *       title: "Quick Start – React", url: "https://react.dev/learn" }
 */
export async function ingestUrl(
  url: string,
  filename?: string,
  metadata?: Record<string, string>
) {
  const client = await getClient();

  console.log(`[mcp:client] Calling url_ingest: "${url}"`);

  const response = await client.callTool({
    name: "url_ingest",
    arguments: { url, filename, metadata },
  });

  const text = (response.content as any[])[0]?.text ?? "{}";
  return JSON.parse(text) as {
    success: boolean;
    chunksStored: number;
    filename: string;
    title: string;
    url: string;
  };
}
