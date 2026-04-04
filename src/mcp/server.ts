/**
 * server.ts — MCP Server
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHAT IS THE MCP SERVER?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * The MCP server is the "host" that:
 *   1. Registers available tools (rag_search, rag_ingest)
 *   2. Listens for MCP protocol messages
 *   3. Routes tool calls to the correct handler
 *   4. Returns results in MCP format
 *
 * TRANSPORT: stdio (standard input/output)
 *   MCP clients (Claude Desktop, Cursor) launch our server as a
 *   child process and communicate via stdin/stdout pipes.
 *   This is the standard MCP transport for local tools.
 *
 *   Client process                Our MCP server process
 *       │                                │
 *       │── JSON-RPC over stdin ─────────▶│
 *       │◀─ JSON-RPC over stdout ─────────│
 *
 * ALTERNATIVE TRANSPORT: HTTP/SSE
 *   For remote MCP servers (deployed to cloud), you'd use HTTP+SSE.
 *   We use stdio for local development — simpler, no auth needed.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * MCP PROTOCOL FLOW:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. Client connects → server responds with capabilities
 * 2. Client calls tools/list → server returns tool definitions
 * 3. Client calls tools/call → server routes to handler → returns result
 *
 * ALL of this is handled by the MCP SDK — we just register tools
 * and write handlers. The protocol boilerplate is abstracted away.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SDK VERSION NOTE (v1.29.0):
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * The old API (deprecated as of v1.29.0):
 *   server.tool(name, description, zodSchema, handler)
 *   ❌ Causes "Type instantiation is excessively deep" TS error
 *
 * The new API (v1.29.0+):
 *   server.registerTool(name, { description, inputSchema }, handler)
 *   ✅ Clean, no TS errors, future-proof
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * HOW TO CONNECT CURSOR TO THIS MCP SERVER:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Add to Cursor settings (cursor://settings/mcp):
 * {
 *   "mcpServers": {
 *     "aisde": {
 *       "command": "npx",
 *       "args": ["ts-node", "src/mcp/server.ts"],
 *       "cwd": "C:/SVN/coldPlayPhase3Development/AIsde"
 *     }
 *   }
 * }
 *
 * After connecting, Cursor can call rag_search and rag_ingest
 * directly from the chat interface — no manual API calls needed.
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleRagSearch } from "./tools/rag_search";
import { handleRagIngest } from "./tools/rag_ingest";
import { handleUrlFetch } from "./tools/url_fetch";
import { handleUrlIngest } from "./tools/url_ingest";

// ── Create MCP Server instance ────────────────────────────────────
// name + version appear in tools/list response
// clients use these to identify which server they're talking to
const server = new McpServer({
  name: "aisde-rag-server",
  version: "1.0.0",
});

// ── Register rag_search tool ──────────────────────────────────────
// SDK v1.29.0 uses registerTool(name, options, handler)
// options: { description, inputSchema (Zod object) }
// handler receives validated args typed from the Zod schema
server.registerTool(
  "rag_search",
  {
    description:
      "Search the RAG knowledge base for relevant document chunks. " +
      "Use this when you need to find information from ingested documents. " +
      "Returns the top matching chunks with their source filenames and similarity scores.",
    // inputSchema is a Zod object — SDK validates args before calling handler
    inputSchema: {
      query: z.string().min(1).describe("The search query — a question or topic to search for"),
      topK:  z.number().min(1).max(10).optional().default(5).describe("Number of chunks to return"),
    },
  },
  // Handler — called after Zod validation passes
  // args is typed as { query: string, topK: number } automatically
  async ({ query, topK }) => handleRagSearch({ query, topK })
);

// ── Register rag_ingest tool ──────────────────────────────────────
server.registerTool(
  "rag_ingest",
  {
    description:
      "Ingest a document into the RAG knowledge base. " +
      "The document will be chunked, embedded, and stored in Chroma for future searches. " +
      "Use this when you want to add new information that agents can later retrieve.",
    inputSchema: {
      content:  z.string().min(1).describe("The full text content of the document to ingest"),
      filename: z.string().min(1).describe("A unique name for this document (e.g. 'policy.txt')"),
      metadata: z.record(z.string()).optional().describe("Optional key-value metadata"),
    },
  },
  async ({ content, filename, metadata }) => handleRagIngest({ content, filename, metadata })
);

// ── Register url_fetch tool ───────────────────────────────────────
// Fetches a URL and returns clean text — useful before ingesting
server.registerTool(
  "url_fetch",
  {
    description:
      "Fetches a URL and returns clean readable text content (HTML stripped). " +
      "Use this to read web pages or documentation before ingesting them.",
    inputSchema: {
      url:      z.string().url().describe("The URL to fetch"),
      maxChars: z.number().min(1).optional().default(15000).describe("Max characters to return"),
    },
  },
  async ({ url, maxChars }) => handleUrlFetch({ url, maxChars })
);

// ── Register url_ingest tool ──────────────────────────────────────
// Fetch + ingest in one call — the most useful tool for adding web content
server.registerTool(
  "url_ingest",
  {
    description:
      "Fetches a URL and ingests its content into the RAG knowledge base in one step. " +
      "Use this to add web pages, documentation, or articles to the knowledge base.",
    inputSchema: {
      url:      z.string().url().describe("The URL to fetch and ingest"),
      filename: z.string().optional().describe("Optional custom document name"),
      metadata: z.record(z.string()).optional().describe("Optional key-value metadata"),
    },
  },
  async ({ url, filename, metadata }) => handleUrlIngest({ url, filename, metadata })
);

// ── Start server with stdio transport ────────────────────────────
// StdioServerTransport reads from process.stdin, writes to process.stdout
// This is how MCP clients (Cursor, Claude Desktop) communicate with us
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (not stdout) — stdout is reserved for MCP protocol messages
  // If we log to stdout, it corrupts the JSON-RPC stream
  console.error("[mcp] AIsde RAG MCP server running on stdio");
  console.error("[mcp] Tools registered: rag_search, rag_ingest, url_fetch, url_ingest");
}

main().catch((err) => {
  console.error("[mcp] Fatal error:", err);
  process.exit(1);
});
