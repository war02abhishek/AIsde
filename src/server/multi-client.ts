/**
 * multi-client.ts — Multi-Server MCP Client
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHY A MULTI-SERVER CLIENT?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Our single client.ts connects to ONE server (our own, in-process).
 * But the real power of MCP is connecting to MULTIPLE servers:
 *
 *   MultiMcpClient
 *     ├── Server A: aisde-rag (our server, in-process)
 *     │     tools: rag_search, rag_ingest, url_fetch, url_ingest
 *     │
 *     └── Server B: mcp-server-fetch (external, stdio)
 *           tools: fetch
 *
 * When an agent calls callTool("fetch", { url: "..." }):
 *   → MultiMcpClient looks up: "fetch" belongs to Server B
 *   → Routes the call to Server B automatically
 *   → Returns the result
 *
 * The agent doesn't need to know WHICH server owns which tool.
 * It just calls tools by name — the multi-client handles routing.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * THIS IS HOW CURSOR/CLAUDE DESKTOP WORKS INTERNALLY:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Cursor connects to all your configured MCP servers on startup.
 * It builds a unified tool registry from all of them.
 * When you ask it something, it picks tools from any server.
 * You never see which server a tool came from — it's transparent.
 *
 * We're building the same thing, but in TypeScript.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * TWO TRANSPORT TYPES:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. InMemoryTransport (our server):
 *    Client ──(in-memory)──▶ Server (same Node.js process)
 *    Fast, no serialization, no child process
 *
 * 2. StdioClientTransport (external server):
 *    Client ──(stdin/stdout)──▶ Server (child process)
 *    Spawns the external server as a child process
 *    Communicates via JSON-RPC over stdin/stdout pipes
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * TOOL CHAINING EXAMPLE (what your agent can now do):
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * User: "Ingest the React docs from https://react.dev/learn"
 *
 * Agent:
 *   Step 1: multiClient.callTool("fetch", { url: "https://react.dev/learn" })
 *           → routes to external mcp-server-fetch
 *           → returns { content: "Quick Start – React\n\nReact lets you..." }
 *
 *   Step 2: multiClient.callTool("rag_ingest", { content: ..., filename: "react-docs" })
 *           → routes to our aisde-rag server
 *           → chunks + embeds + stores in Chroma
 *
 * Two different servers, one unified interface. ✅
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleRagSearch } from "../mcp/tools/rag_search";
import { handleRagIngest } from "../mcp/tools/rag_ingest";
import { handleUrlFetch } from "../mcp/tools/url_fetch";
import { handleUrlIngest } from "../mcp/tools/url_ingest";

// ── Types ─────────────────────────────────────────────────────────

export interface ToolInfo {
  name: string;
  description: string;
  serverName: string; // which server owns this tool
}

interface ServerConnection {
  name: string;
  client: Client;
  tools: string[]; // tool names this server provides
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MultiMcpClient — connects to multiple servers, routes tool calls
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class MultiMcpClient {
  // Map of serverName → connection
  private servers = new Map<string, ServerConnection>();

  // Map of toolName → serverName (for fast routing)
  // e.g. "fetch" → "mcp-fetch", "rag_search" → "aisde-rag"
  private toolRegistry = new Map<string, string>();

  /**
   * Connects to our own in-process MCP server
   * Uses InMemoryTransport — no child process, no network
   * Used in LOCAL DEV when MCP_SERVER_URL is not set
   *
   * This is always connected — it's our core server.
   */
  async connectInProcess(): Promise<void> {
    console.log("[multi-client] Connecting to in-process aisde-rag server...");

    const inProcessServer = new Server(
      { name: "aisde-rag", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    (inProcessServer as any).setRequestHandler("tools/list", async () => ({
      tools: [
        { name: "rag_search", description: "Search the RAG knowledge base.", inputSchema: { type: "object", properties: { query: { type: "string" }, topK: { type: "number" } }, required: ["query"] } },
        { name: "rag_ingest", description: "Ingest a document into the RAG knowledge base.", inputSchema: { type: "object", properties: { content: { type: "string" }, filename: { type: "string" }, metadata: { type: "object" } }, required: ["content", "filename"] } },
        { name: "url_fetch",  description: "Fetch a URL and return clean text.", inputSchema: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "number" } }, required: ["url"] } },
        { name: "url_ingest", description: "Fetch a URL and ingest into RAG.", inputSchema: { type: "object", properties: { url: { type: "string" }, filename: { type: "string" }, metadata: { type: "object" } }, required: ["url"] } },
      ],
    }));

    (inProcessServer as any).setRequestHandler("tools/call", async (req: any) => {
      const { name, arguments: args = {} } = req.params as { name: string; arguments: Record<string, unknown> };
      switch (name) {
        case "rag_search": return handleRagSearch(args as { query: string; topK?: number });
        case "rag_ingest": return handleRagIngest(args as { content: string; filename: string; metadata?: Record<string, string> });
        case "url_fetch":  return handleUrlFetch(args as { url: string; maxChars?: number });
        case "url_ingest": return handleUrlIngest(args as { url: string; filename?: string; metadata?: Record<string, string> });
        default: throw new Error(`Unknown tool: ${name}`);
      }
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await inProcessServer.connect(serverTransport);

    const client = new Client({ name: "aisde-multi-client", version: "1.0.0" });
    await client.connect(clientTransport);

    this.servers.set("aisde-rag", { name: "aisde-rag", client, tools: ["rag_search", "rag_ingest", "url_fetch", "url_ingest"] });
    ["rag_search", "rag_ingest", "url_fetch", "url_ingest"].forEach((t) => this.toolRegistry.set(t, "aisde-rag"));
    console.log("[multi-client] aisde-rag connected. Tools: rag_search, rag_ingest, url_fetch, url_ingest");
  }

  /**
   * Connects to an EXTERNAL MCP server via stdio transport
   * Spawns the server as a child process and communicates via stdin/stdout
   *
   * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   * HOW STDIO TRANSPORT WORKS:
   * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   *
   * StdioClientTransport spawns: command + args as a child process
   * Then pipes JSON-RPC messages via stdin/stdout:
   *
   *   Our process                Child process (external MCP server)
   *       │                              │
   *       │── write to child.stdin ──────▶│  receives JSON-RPC request
   *       │◀─ read from child.stdout ─────│  sends JSON-RPC response
   *
   * Example: connectExternal("mcp-fetch", "uvx", ["mcp-server-fetch"])
   *   → spawns: uvx mcp-server-fetch
   *   → that process starts the Python fetch MCP server
   *   → we communicate with it via stdin/stdout
   *
   * @param serverName - Friendly name for this server (used in logs)
   * @param command    - Executable to run (e.g. "uvx", "npx", "node")
   * @param args       - Arguments to pass (e.g. ["mcp-server-fetch"])
   * @param env        - Optional environment variables for the child process
   */
  async connectExternal(
    serverName: string,
    command: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<void> {
    console.log(`[multi-client] Connecting to external server "${serverName}" via stdio...`);
    console.log(`[multi-client] Command: ${command} ${args.join(" ")}`);

    try {
      // StdioClientTransport spawns the external server as a child process
      // and sets up stdin/stdout pipes for JSON-RPC communication
      const transport = new StdioClientTransport({
        command,
        args,
        env: { ...process.env, ...env } as Record<string, string>,
      });

      const client = new Client({ name: `aisde-client-${serverName}`, version: "1.0.0" });
      await client.connect(transport);

      // Discover what tools this server provides via tools/list
      // This is MCP's "discovery" mechanism — we don't hardcode tool names
      const toolsResponse = await client.listTools();
      const toolNames = toolsResponse.tools.map((t) => t.name);

      console.log(`[multi-client] "${serverName}" connected. Tools: ${toolNames.join(", ")}`);

      // Register server and its tools
      this.servers.set(serverName, { name: serverName, client, tools: toolNames });
      toolNames.forEach((t) => this.toolRegistry.set(t, serverName));

    } catch (err: any) {
      // External server connection failure is non-fatal
      // Our in-process server still works — we just lose the external tools
      console.warn(`[multi-client] Failed to connect to "${serverName}": ${err.message}`);
      console.warn(`[multi-client] Continuing without "${serverName}" tools`);
    }
  }

  /**
   * Calls a tool by name — automatically routes to the correct server
   *
   * ROUTING LOGIC:
   *   1. Look up toolName in toolRegistry → get serverName
   *   2. Get the client for that server
   *   3. Call the tool on that client
   *
   * If the tool isn't found in any server:
   *   → Falls back to our in-process server (graceful degradation)
   *
   * @param toolName  - Name of the tool to call (e.g. "fetch", "rag_search")
   * @param args      - Arguments to pass to the tool
   * @returns         - Raw MCP tool response
   *
   * Example:
   *   callTool("fetch", { url: "https://react.dev" })
   *   → routes to "mcp-fetch" server (external)
   *   → returns { content: [{ type: "text", text: "React docs..." }] }
   *
   *   callTool("rag_search", { query: "What is RAG?" })
   *   → routes to "aisde-rag" server (in-process)
   *   → returns { content: [{ type: "text", text: "{chunks: [...]}" }] }
   */
  async callTool(toolName: string, args: Record<string, unknown>) {
    const serverName = this.toolRegistry.get(toolName);

    if (!serverName) {
      throw new Error(
        `Tool "${toolName}" not found in any connected server. ` +
        `Available tools: ${Array.from(this.toolRegistry.keys()).join(", ")}`
      );
    }

    const server = this.servers.get(serverName)!;
    console.log(`[multi-client] Routing "${toolName}" → server "${serverName}"`);

    return server.client.callTool({ name: toolName, arguments: args });
  }

  /**
   * Returns all available tools across all connected servers
   * Used by the orchestrator to know what tools are available
   *
   * Example output:
   *   [
   *     { name: "rag_search",  description: "...", serverName: "aisde-rag" },
   *     { name: "rag_ingest",  description: "...", serverName: "aisde-rag" },
   *     { name: "fetch",       description: "...", serverName: "mcp-fetch" },
   *   ]
   */
  async listAllTools(): Promise<ToolInfo[]> {
    const allTools: ToolInfo[] = [];

    for (const [serverName, connection] of this.servers) {
      try {
        const response = await connection.client.listTools();
        response.tools.forEach((t) => {
          allTools.push({
            name: t.name,
            description: t.description ?? "",
            serverName,
          });
        });
      } catch (err: any) {
        console.warn(`[multi-client] Failed to list tools from "${serverName}": ${err.message}`);
      }
    }

    return allTools;
  }

  /**
   * Checks if a specific tool is available across any connected server
   *
   * @param toolName - Tool name to check
   * @returns        - true if available, false if not
   *
   * Example:
   *   hasToolAvailable("fetch")    → true if mcp-fetch server is connected
   *   hasToolAvailable("rag_search") → always true (in-process server)
   */
  hasTool(toolName: string): boolean {
    return this.toolRegistry.has(toolName);
  }

  /**
   * Returns names of all connected servers
   */
  getConnectedServers(): string[] {
    return Array.from(this.servers.keys());
  }

  /**
   * Connects to a REMOTE MCP server via HTTP transport (production, Model B)
   * Used when MCP_SERVER_URL env var is set
   *
   * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   * HOW HTTP TRANSPORT WORKS:
   * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   *
   * StreamableHTTPClientTransport sends POST requests to the MCP server:
   *
   *   Express container (this code)    MCP container (server.ts HTTP mode)
   *       │                                    │
   *       │── POST http://mcp:4000/mcp ──────▶│  handles request
   *       │◀─ JSON response ────────────────│  returns result
   *
   * COMPARE WITH InMemoryTransport (local dev):
   *   InMemory:  no network, same process, zero latency
   *   HTTP:      network hop, separate process, ~1-5ms latency
   *
   * The tool call API (callTool, searchDocs etc.) is IDENTICAL.
   * Only the transport changes — that's the beauty of MCP.
   *
   * @param serverUrl - Full URL of the MCP HTTP server e.g. http://mcp-service:4000
   */
  async connectHttp(serverUrl: string): Promise<void> {
    console.log(`[multi-client] Connecting to remote MCP server via HTTP: ${serverUrl}`);

    const maxRetries = 10;
    const retryDelayMs = 3000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`));
        const client = new Client({ name: "aisde-http-client", version: "1.0.0" });
        await client.connect(transport);

        const toolsResponse = await client.listTools();
        const toolNames = toolsResponse.tools.map((t) => t.name);

        console.log(`[multi-client] Remote MCP server connected. Tools: ${toolNames.join(", ")}`);
        this.servers.set("aisde-rag", { name: "aisde-rag", client, tools: toolNames });
        toolNames.forEach((t) => this.toolRegistry.set(t, "aisde-rag"));
        return;

      } catch (err: any) {
        console.warn(`[multi-client] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt < maxRetries) {
          console.warn(`[multi-client] Retrying in ${retryDelayMs / 1000}s...`);
          await new Promise((r) => setTimeout(r, retryDelayMs));
        } else {
          console.error(`[multi-client] All ${maxRetries} attempts failed. Falling back to in-process server.`);
          await this.connectInProcess();
        }
      }
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Singleton instance + initialization
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Singleton — one MultiMcpClient shared across the whole app
export const multiClient = new MultiMcpClient();

let initialized = false;

/**
 * Initializes the multi-client — connects to all configured servers
 * Called once at server startup from server/index.ts
 *
 * WHAT IT CONNECTS TO:
 *   1. Our in-process server (always) — rag_search, rag_ingest, url_fetch, url_ingest
 *   2. External mcp-server-fetch (if uvx is available) — fetch tool
 *      Falls back gracefully if uvx/Python not installed
 *
 * HOW TO ADD MORE EXTERNAL SERVERS:
 *   await multiClient.connectExternal("github", "npx", ["-y", "@modelcontextprotocol/server-github"], {
 *     GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? ""
 *   });
 */
export async function initMultiClient(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // ── Transport selection based on MCP_SERVER_URL env var ────────────────────────
  //
  // LOCAL DEV (MCP_SERVER_URL not set):
  //   Uses InMemoryTransport — MCP server runs in-process
  //   No network hop, fastest possible, no extra process needed
  //
  // PRODUCTION / Model B (MCP_SERVER_URL=http://mcp-service:4000):
  //   Uses StreamableHTTPClientTransport — MCP server is a separate container
  //   Express container calls MCP container over HTTP
  //
  // This single env var is the ONLY thing that changes between local and production.
  // All tool calls (callTool, searchDocs, ingestDoc etc.) stay identical.
  const mcpServerUrl = process.env.MCP_SERVER_URL;

  if (mcpServerUrl) {
    // ── PRODUCTION: HTTP transport (Model B) ──────────────────────────────
    // MCP server is a separate service — connect to it over HTTP
    console.log(`[multi-client] MCP_SERVER_URL=${mcpServerUrl} — production HTTP mode`);
    await multiClient.connectHttp(mcpServerUrl);
  } else {
    // ── LOCAL DEV: InMemory transport ──────────━─────────────────────────
    // MCP server runs in-process — no network, no extra container
    console.log(`[multi-client] MCP_SERVER_URL not set — local dev in-process mode`);
    await multiClient.connectInProcess();
  }

  // Step 2: Connect external MCP servers
  // Now available in both local dev and Docker production
  console.log(`[multi-client] Connecting external stdio servers...`);
  
  // Option 1: Python mcp-server-fetch (better web scraping)
  await multiClient.connectExternal(
    "mcp-fetch", 
    "uvx", 
    ["mcp-server-fetch"],
    {
      HTTP_PROXY: process.env.HTTPS_PROXY ?? "",
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? "",
      PYTHONHTTPSVERIFY: "0",
      CURL_CA_BUNDLE: "",
      REQUESTS_CA_BUNDLE: "",
    }
  );
  
  // Option 2: GitHub MCP server (if you have GitHub token)
  if (process.env.GITHUB_TOKEN) {
    await multiClient.connectExternal(
      "github",
      "npx",
      ["-y", "@modelcontextprotocol/server-github"],
      {
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN,
      }
    );
  }
  
  // Option 3: Filesystem MCP server
  await multiClient.connectExternal(
    "filesystem",
    "npx",
    ["-y", "@modelcontextprotocol/server-filesystem", "/app"]
  );



  const servers = multiClient.getConnectedServers();
  const tools   = await multiClient.listAllTools();

  console.log(`[multi-client] Initialized. Servers: [${servers.join(", ")}]`);
  console.log(`[multi-client] Total tools available: ${tools.length}`);
  tools.forEach((t) => console.log(`[multi-client]   ${t.name} (${t.serverName})`));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Typed helper: fetch via best available tool
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Fetches a URL using the best available fetch tool:
 *   - If external "mcp-fetch" server is connected → use its "fetch" tool
 *     (better quality: returns clean markdown, handles JS-rendered pages)
 *   - Otherwise → fall back to our own "url_fetch" tool
 *     (always available, uses node-fetch + cheerio)
 *
 * This is the key benefit of multi-server: automatic fallback.
 * Your agent code doesn't change — it just calls fetchBest().
 *
 * @param url - URL to fetch
 * @returns   - { text: string, title?: string }
 */
export async function fetchBest(url: string): Promise<{ text: string; title?: string }> {
  console.log(`\n${"-".repeat(50)}`);
  console.log(`[multi-client] 🔍 fetchBest called for: ${url}`);
  console.log(`[multi-client] External "fetch" tool available: ${multiClient.hasTool("fetch")}`);
  console.log(`[multi-client] Connected servers: [${multiClient.getConnectedServers().join(", ")}]`);

  if (multiClient.hasTool("fetch")) {
    console.log(`[multi-client] ⭐ Using PYTHON mcp-server-fetch (Mozilla Readability → clean markdown)`);
    const response = await multiClient.callTool("fetch", { url });
    const raw = (response.content as any[])[0]?.text ?? "";
    console.log(`[multi-client] ✅ Python fetch returned ${raw.length} chars`);
    console.log(`[multi-client] 👁️  Preview: "${raw.slice(0, 150).replace(/\n/g, " ")}..."`);
    console.log(`${"-".repeat(50)}\n`);
    return { text: raw };
  }

  console.log(`[multi-client] ⚠️  Falling back to our url_fetch tool (cheerio HTML stripping)`);
  const response = await multiClient.callTool("url_fetch", { url });
  const parsed = JSON.parse((response.content as any[])[0]?.text ?? "{}");
  console.log(`[multi-client] ✅ Fallback fetch returned ${parsed.text?.length ?? 0} chars`);
  console.log(`${"-".repeat(50)}\n`);
  return { text: parsed.text ?? "", title: parsed.title };
}

/**
 * Fetches a URL and ingests it using tool chaining:
 *   Step 1: fetchBest(url)     → get clean text (external or fallback)
 *   Step 2: rag_ingest(text)   → chunk + embed + store in Chroma
 *
 * This is the REAL MCP tool chaining pattern:
 *   External server provides the fetch capability
 *   Our server provides the ingest capability
 *   The agent chains them together
 *
 * @param url      - URL to fetch and ingest
 * @param filename - Optional custom document name
 * @param metadata - Optional key-value metadata
 */
export async function fetchAndIngest(
  url: string,
  filename?: string,
  metadata?: Record<string, string>
): Promise<{ success: boolean; chunksStored: number; filename: string; source: string }> {

  console.log(`\n${"-".repeat(50)}`);
  console.log(`[multi-client] 🚀 fetchAndIngest START`);
  console.log(`[multi-client] URL     : ${url}`);
  console.log(`[multi-client] Filename: ${filename ?? "(auto-derived from URL)"}`);

  // Step 1: Fetch using best available tool
  console.log(`[multi-client] 🌐 STEP 1 — Fetching content...`);
  const { text, title } = await fetchBest(url);

  console.log(`[multi-client] ✅ Fetched ${text.length} chars`);

  if (!text || text.length < 50) {
    throw new Error(`Fetched content too short (${text.length} chars) — page may be empty or blocked`);
  }

  const derivedFilename = filename ?? url
    .replace(/^https?:\/\//, "")
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9.-]/g, "")
    .slice(0, 80);

  console.log(`[multi-client] 💾 STEP 2 — Ingesting as "${derivedFilename}" via rag_ingest tool...`);
  console.log(`[multi-client] Routing rag_ingest → server "aisde-rag" (in-process)`);

  const ingestResponse = await multiClient.callTool("rag_ingest", {
    content: text,
    filename: derivedFilename,
    metadata: {
      ...metadata,
      sourceUrl: url,
      pageTitle: title ?? "",
      fetchedBy: multiClient.hasTool("fetch") ? "mcp-server-fetch" : "url_fetch-fallback",
      ingestedAt: new Date().toISOString(),
    },
  });

  const result = JSON.parse((ingestResponse.content as any[])[0]?.text ?? "{}");
  const source = multiClient.hasTool("fetch") ? "mcp-server-fetch" : "url_fetch-fallback";

  console.log(`[multi-client] ✅ Ingest done: ${result.chunksStored} chunks stored`);
  console.log(`[multi-client] 🏁 fetchAndIngest COMPLETE`);
  console.log(`[multi-client]   filename : ${derivedFilename}`);
  console.log(`[multi-client]   chunks   : ${result.chunksStored}`);
  console.log(`[multi-client]   source   : ${source}`);
  console.log(`${"-".repeat(50)}\n`);

  return {
    success: true,
    chunksStored: result.chunksStored ?? 0,
    filename: derivedFilename,
    source,
  };
}
