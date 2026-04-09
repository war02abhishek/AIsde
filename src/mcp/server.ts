import "dotenv/config";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleRagSearch } from "./tools/rag_search";
import { handleRagIngest } from "./tools/rag_ingest";
import { handleUrlFetch } from "./tools/url_fetch";
import { handleUrlIngest } from "./tools/url_ingest";

const USE_HTTP = process.env.HTTP_TRANSPORT === "true";
const PORT     = Number(process.env.MCP_PORT ?? 4000);

const TOOLS = [
  { name: "rag_search", description: "Search the RAG knowledge base for relevant document chunks.", inputSchema: { type: "object", properties: { query: { type: "string" }, topK: { type: "number" } }, required: ["query"] } },
  { name: "rag_ingest", description: "Ingest a document into the RAG knowledge base.", inputSchema: { type: "object", properties: { content: { type: "string" }, filename: { type: "string" }, metadata: { type: "object" } }, required: ["content", "filename"] } },
  { name: "url_fetch",  description: "Fetches a URL and returns clean readable text content.", inputSchema: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "number" } }, required: ["url"] } },
  { name: "url_ingest", description: "Fetches a URL and ingests its content into the RAG knowledge base.", inputSchema: { type: "object", properties: { url: { type: "string" }, filename: { type: "string" }, metadata: { type: "object" } }, required: ["url"] } },
];

function createServer(): Server {
  const server = new Server(
    { name: "aisde-rag-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({ tools: TOOLS })
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req: any) => {
      const { name, arguments: args = {} } = req.params as { name: string; arguments: Record<string, unknown> };
      switch (name) {
        case "rag_search": return handleRagSearch(args as { query: string; topK?: number });
        case "rag_ingest": return handleRagIngest(args as { content: string; filename: string; metadata?: Record<string, string> });
        case "url_fetch":  return handleUrlFetch(args as { url: string; maxChars?: number });
        case "url_ingest": return handleUrlIngest(args as { url: string; filename?: string; metadata?: Record<string, string> });
        default: throw new Error(`Unknown tool: ${name}`);
      }
    }
  );

  return server;
}

async function main() {
  if (USE_HTTP) {
    const app = express();
    app.use(express.json());

    app.get("/health", (_req, res) => {
      res.json({ status: "ok", transport: "http", tools: TOOLS.length });
    });

    app.post("/mcp", async (req, res) => {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.listen(PORT, () => {
      console.log(`[mcp] HTTP server on port ${PORT}`);
      console.log(`[mcp] POST http://localhost:${PORT}/mcp`);
      console.log(`[mcp] GET  http://localhost:${PORT}/health`);
    });

  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[mcp] stdio server ready");
  }
}

main().catch((err) => {
  console.error("[mcp] Fatal error:", err);
  process.exit(1);
});
