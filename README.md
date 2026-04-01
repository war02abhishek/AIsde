# AIsde — RAG + Agents System

## Setup

```bash
npm install
cp .env.example .env   # fill in your OPENAI_API_KEY
npm run dev
```

## API Contracts

### GET /health
```json
{ "status": "ok", "timestamp": "...", "env": "development" }
```

### POST /chat
Request:
```json
{ "message": "What is RAG?", "sessionId": "optional-uuid" }
```
Response:
```json
{
  "answer": "...",
  "citations": [{ "source": "doc.pdf", "chunk": "...", "score": 0.9 }],
  "followUpQuestions": ["..."],
  "sessionId": "uuid"
}
```

### POST /ingest
Request:
```json
{ "content": "full document text", "filename": "doc.pdf", "metadata": {} }
```
Response:
```json
{ "success": true, "chunksStored": 12, "filename": "doc.pdf" }
```

## Phases
- [x] Phase 0: Scaffold + API contracts
- [ ] Phase 1: RAG pipeline (chunking + embeddings + Chroma)
- [ ] Phase 2: Structured outputs + Zod validation loop
- [ ] Phase 3: Session memory + summarization
- [ ] Phase 4: Multi-agent orchestration (LangGraph)
- [ ] Phase 5: Evaluation + monitoring
- [ ] Phase 6: MCP tool integration
