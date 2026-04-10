# AIsde — RAG + Multi-Agent System

A production-grade Retrieval Augmented Generation (RAG) system with multi-agent orchestration, session memory, evaluation framework, and MCP (Model Context Protocol) tool integration. Built with TypeScript + Node.js, containerised with Docker.

## Architecture

```
React Frontend (Vite)
        │
        ▼
  Express API (port 3000)
        │
        ├── Multi-Agent Graph
        │     ├── Orchestrator  — classifies + rewrites queries
        │     ├── Retrieval     — parallel vector search + dedup
        │     └── Critic        — generates answer + evaluates faithfulness
        │
        ├── Session Memory      — per-session conversation + summarization
        │
        └── MCP Client
              │
              ├── aisde-rag (HTTP, port 4000)
              │     tools: rag_search, rag_ingest, url_fetch, url_ingest
              │
              └── External servers (local dev only)
                    tools: fetch (mcp-server-fetch), filesystem, github
                          │
                          ▼
                    ChromaDB (port 8000)
                    OpenAI API
```

## Completed Phases

### Phase 0 — Scaffold + API Contracts
- Express server with typed routes
- API contracts for `/health`, `/chat`, `/ingest`
- TypeScript + ts-node-dev setup
- `.env` configuration with dotenv

### Phase 1 — RAG Pipeline
- Document ingestion via `POST /ingest` and `POST /ingest-url`
- **Sentence-aware chunking** — splits on sentence boundaries with overlap (upgraded from fixed-size in Phase 5)
- OpenAI `text-embedding-3-small` embeddings
- ChromaDB vector store with persistent storage
- Similarity search with cosine distance → relevance scores
- Citations returned with every answer (source, chunk, score)

### Phase 2 — Structured Outputs + Zod Validation
- Zod schemas for all LLM outputs (`answer.ts`)
- Orchestrator uses `response_format: json_object` + Zod parse
- Critic agent uses structured JSON scoring
- Runtime validation loop — retries on schema mismatch

### Phase 3 — Session Memory + Summarization
- Per-session conversation history (`sessionId` → turns)
- Automatic summarization when turns exceed `MAX_TURNS` (6)
- Summary injected into orchestrator prompt for context-aware query rewriting
- In-memory store (resets on restart — persistent storage is a future phase)

### Phase 4 — Multi-Agent Orchestration
Manual state machine implementation (no framework):

| Agent | Responsibility |
|---|---|
| **Orchestrator** | Classifies question (simple/complex), rewrites into 1–4 optimised search queries |
| **Retrieval** | Runs parallel vector searches, deduplicates chunks by content hash |
| **Critic** | Generates answer, scores faithfulness 1–10, triggers retry if score < 7 |

- Retry loop: critic failure → re-retrieval → re-generation (max 3 attempts)
- LangGraph migration path included as commented code in `graph.ts`

### Phase 5 — Evaluation + Monitoring
- Structured logging via `log()` — every retrieval emits phase, latency, scores
- In-memory log buffer (last 200 entries)
- `GET /eval` — live metrics dashboard (avg scores, latency, chunk counts)
- `POST /eval` — runs 8-question eval dataset through the full pipeline
- Metrics: **Retrieval Recall@k**, **Answer Relevance**, **Latency**
- Sentence-aware chunking upgrade (measurably improves retrieval recall)

### Phase 6 — MCP Tool Integration
- **MCP Server** (`src/mcp/server.ts`) — exposes 4 tools over stdio or HTTP transport
- **Multi-server MCP Client** (`src/server/multi-client.ts`) — unified tool registry across multiple servers
- Automatic transport switching: InMemory (local dev) → HTTP (Docker production)
- External server support: `mcp-server-fetch`, `@modelcontextprotocol/server-github`, `@modelcontextprotocol/server-filesystem`
- `fetchBest()` — uses Python mcp-server-fetch (Mozilla Readability) with fallback to built-in url_fetch

**MCP Tools:**

| Tool | Description |
|---|---|
| `rag_search` | Search ChromaDB for relevant chunks |
| `rag_ingest` | Chunk + embed + store a document |
| `url_fetch` | Fetch a URL and return clean text |
| `url_ingest` | Fetch a URL and ingest into RAG |

## Docker Architecture (Production)

Three-container setup via `docker-compose.yml`:

```
chroma   (port 8000) — vector database, persistent volume
mcp      (port 4000) — MCP HTTP server
express  (port 3000) — API server + agents
web      (port 5173) — React frontend via nginx
```

```bash
# Start all services
docker compose up -d

# Rebuild after code changes
docker compose up -d --build

# View logs
docker compose logs -f express

# Reset vector data
docker compose down -v
```

## Local Development

```bash
npm install
cp .env.example .env   # fill in OPENAI_API_KEY

# Start ChromaDB
docker compose up -d chroma

# Start Express API
npm run dev

# Start MCP server (separate terminal, optional)
npm run mcp
```

## API Reference

### GET /health
```json
{ "status": "ok", "timestamp": "...", "env": "development" }
```

### POST /chat
```json
// Request
{ "message": "What is RAG?", "sessionId": "optional-uuid" }

// Response
{
  "answer": "...",
  "citations": [{ "source": "doc.pdf", "chunk": "...", "score": 0.9 }],
  "followUpQuestions": ["..."],
  "sessionId": "uuid"
}
```

### POST /ingest
```json
// Request
{ "content": "full document text", "filename": "doc.pdf", "metadata": {} }

// Response
{ "success": true, "chunksStored": 12, "filename": "doc.pdf" }
```

### POST /ingest-url
```json
// Request
{ "url": "https://example.com/article", "filename": "optional-name" }

// Response
{ "success": true, "chunksStored": 8, "filename": "example.com-article", "source": "mcp-server-fetch" }
```

### GET /eval
Returns live metrics from the log buffer.

### POST /eval
Runs the 8-question eval dataset and returns recall, relevance, and latency scores.

## Environment Variables

```env
OPENAI_API_KEY=sk-...

# ChromaDB
CHROMA_HOST=localhost
CHROMA_PORT=8000
CHROMA_COLLECTION=aisde_docs

# MCP
MCP_SERVER_URL=           # leave empty for local dev (in-process), set to http://mcp:4000 for Docker
HTTP_TRANSPORT=false      # true = MCP server listens on HTTP
MCP_PORT=4000

# External MCP servers (optional)
GITHUB_TOKEN=             # enables @modelcontextprotocol/server-github

# Proxy (corporate environments)
HTTPS_PROXY=
HTTP_PROXY=
NODE_TLS_REJECT_UNAUTHORIZED=
```

## Tech Stack

| Layer | Technology |
|---|---|
| API | Node.js, Express, TypeScript |
| LLM | OpenAI GPT-4o-mini |
| Embeddings | OpenAI text-embedding-3-small |
| Vector DB | ChromaDB |
| Validation | Zod |
| MCP | @modelcontextprotocol/sdk v1.29 |
| Frontend | React, Vite, TailwindCSS |
| Container | Docker, nginx |

## Roadmap

- [x] Phase 0: Scaffold + API contracts
- [x] Phase 1: RAG pipeline (chunking + embeddings + Chroma)
- [x] Phase 2: Structured outputs + Zod validation loop
- [x] Phase 3: Session memory + summarization
- [x] Phase 4: Multi-agent orchestration
- [x] Phase 5: Evaluation + monitoring
- [x] Phase 6: MCP tool integration
- [ ] Phase 7: LangGraph migration (scaffolded in graph.ts)
- [ ] Phase 8: Persistent session storage (Redis)
- [ ] Phase 9: Streaming responses (WebSocket / SSE)
