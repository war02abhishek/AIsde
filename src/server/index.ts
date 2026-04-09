/**
 * index.ts — Express server entry point
 *
 * PURPOSE:
 * Bootstraps the HTTP server, registers middleware, and mounts all routes.
 *
 * MIDDLEWARE:
 *   express.json() — parses incoming request bodies as JSON
 *                    without this, req.body would be undefined
 *
 * ROUTES:
 *   GET  /health  — liveness check
 *   POST /chat    — RAG chat with citations
 *   POST /ingest  — document ingestion pipeline
 *   GET  /eval    — live metrics from log buffer
 *   POST /eval    — run eval dataset
 *
 * PHASE 6 — MCP SERVER:
 *   The MCP server runs separately via: npm run mcp
 *   It exposes two tools over stdio transport:
 *     rag_search — query Chroma, return top chunks
 *     rag_ingest — chunk + embed + store a document
 *
 *   Our agents (retrieval.ts) now call these tools via the
 *   in-process MCP client instead of importing functions directly.
 *
 *   External clients (Cursor, Claude Desktop) can connect by adding
 *   this to their MCP config:
 *   {
 *     "mcpServers": {
 *       "aisde": {
 *         "command": "npx",
 *         "args": ["ts-node", "src/mcp/server.ts"],
 *         "cwd": "C:/SVN/coldPlayPhase3Development/AIsde"
 *       }
 *     }
 *   }
 *
 * ENVIRONMENT:
 *   dotenv/config loads .env file into process.env at startup
 *   so OPENAI_API_KEY, CHROMA_HOST etc. are available everywhere
 */

import "dotenv/config"; // must be first — loads .env before anything else reads process.env
import express from "express";
import healthRouter from "./routes/health";
import chatRouter from "./routes/chat";
import ingestRouter from "./routes/ingest";
import evalRouter from "./routes/eval";
import ingestUrlRouter from "./routes/ingest-url";
import debugRouter from "./routes/debug";
import { initMultiClient } from "./multi-client";

const app = express();
const PORT = process.env.PORT ?? 3000;

// Parse JSON request bodies (required for POST /chat and POST /ingest)
app.use(express.json());

// Mount routers at their respective paths
app.use("/health", healthRouter);
app.use("/chat", chatRouter);
app.use("/ingest", ingestRouter);
app.use("/ingest-url", ingestUrlRouter);
app.use("/debug",      debugRouter);   // ⚠️ dev only
app.use("/eval", evalRouter);

app.listen(PORT, async () => {
  // Initialize multi-server MCP client on startup
  // Connects to: in-process aisde-rag server + external mcp-server-fetch (if available)
  await initMultiClient();

  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  POST /chat`);
  console.log(`  POST /ingest`);
  console.log(`  POST /ingest-url — fetch + ingest a URL`);
  console.log(`  GET  /debug/collections — list Chroma collections`);
  console.log(`  GET  /debug/chunks      — inspect stored chunks`);
  console.log(`  GET  /eval   — live metrics`);
  console.log(`  POST /eval   — run eval dataset`);
});
