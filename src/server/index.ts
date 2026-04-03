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

const app = express();
const PORT = process.env.PORT ?? 3000;

// Parse JSON request bodies (required for POST /chat and POST /ingest)
app.use(express.json());

// Mount routers at their respective paths
app.use("/health", healthRouter);
app.use("/chat", chatRouter);
app.use("/ingest", ingestRouter);
app.use("/eval", evalRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  POST /chat`);
  console.log(`  POST /ingest`);
  console.log(`  GET  /eval   — live metrics`);
  console.log(`  POST /eval   — run eval dataset`);
});
