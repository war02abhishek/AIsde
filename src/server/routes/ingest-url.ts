/**
 * ingest-url.ts — POST /ingest-url route
 *
 * PURPOSE:
 * Accepts a URL and ingests its content into Chroma using MCP tool chaining.
 *
 * FETCH MODE FLAG:
 *   fetchMode = "python" → use external mcp-server-fetch (Mozilla Readability, clean markdown)
 *                          requires Python mcp-server-fetch to be connected
 *   fetchMode = "node"   → use our url_fetch tool (Node.js + cheerio, always works)
 *
 * WHY A FLAG?
 *   Python mcp-server-fetch fails on corporate proxies due to SSL cert issues.
 *   Our Node.js url_fetch works fine through the proxy.
 *   The flag lets the user choose which fetcher to use from the UI.
 *
 * PIPELINE:
 *   POST /ingest-url { url, fetchMode }
 *     ↓
 *   fetchMode="python" → fetchAndIngest() → Python fetch → rag_ingest
 *   fetchMode="node"   → fetchAndIngest() → Node.js fetch → rag_ingest
 *     ↓
 *   { success, chunksStored, filename, source }
 *
 * EXAMPLE REQUEST:
 *   POST /ingest-url
 *   { "url": "https://react.dev/learn", "fetchMode": "node" }
 *
 * EXAMPLE RESPONSE:
 *   {
 *     "success": true,
 *     "chunksStored": 14,
 *     "filename": "react.dev-learn",
 *     "source": "url_fetch-node"
 *   }
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { multiClient, fetchAndIngest} from "../multi-client"

const router = Router();

const IngestUrlRequestSchema = z.object({
  url:       z.string().url("Must be a valid URL starting with http:// or https://"),
  filename:  z.string().optional(),
  metadata:  z.record(z.string()).optional(),
  // fetchMode: which fetch tool to use
  // "python" = mcp-server-fetch (better quality, may fail on corporate proxy)
  // "node"   = our url_fetch (always works, uses Node.js + cheerio)
  fetchMode: z.enum(["python", "node"]).optional().default("node"),
});

router.post("/", async (req: Request, res: Response) => {
  const parsed = IngestUrlRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { url, filename, metadata, fetchMode } = parsed.data;

  console.log(`[ingest-url] fetchMode="${fetchMode}" url="${url}"`);

  try {
    let result: { success: boolean; chunksStored: number; filename: string; source: string };

    if (fetchMode === "python") {
      // ── Python mcp-server-fetch ──────────────────────────────────
      // Uses Mozilla Readability algorithm → clean markdown output
      // May fail on corporate proxies due to SSL cert issues
      if (!multiClient.hasTool("fetch")) {
        res.status(503).json({
          error: "Python mcp-server-fetch is not connected. Switch to Node.js mode or check server logs.",
        });
        return;
      }
      console.log(`[ingest-url] Using Python mcp-server-fetch...`);
      // fetchAndIngest uses fetchBest() which picks Python if available
      result = await fetchAndIngest(url, filename, metadata);

    } else {
      // ── Node.js url_fetch (our tool) ─────────────────────────────
      // Uses Node.js built-in fetch + cheerio HTML stripping
      // Always works through corporate proxy (HTTPS_PROXY in .env)
      console.log(`[ingest-url] Using Node.js url_fetch...`);

      // Call url_fetch directly on our in-process server — bypasses fetchBest()
      // so it never tries the Python server even if connected
      const fetchResponse = await multiClient.callTool("url_fetch", { url });
      const fetchResult = JSON.parse(
        (fetchResponse.content as any[])[0]?.text ?? "{}"
      ) as { url: string; title: string; text: string; charCount: number };

      console.log(`[ingest-url] Fetched "${fetchResult.title}" (${fetchResult.charCount} chars)`);

      if (!fetchResult.text || fetchResult.text.length < 50) {
        res.status(422).json({
          error: `Fetched content too short (${fetchResult.text?.length ?? 0} chars) — page may be blocked`,
        });
        return;
      }

      // Derive filename from URL if not provided
      const derivedFilename = filename ?? url
        .replace(/^https?:\/\//, "")
        .replace(/\//g, "-")
        .replace(/[^a-zA-Z0-9.-]/g, "")
        .slice(0, 80);

      // Ingest via our rag_ingest tool
      const ingestResponse = await multiClient.callTool("rag_ingest", {
        content: fetchResult.text,
        filename: derivedFilename,
        metadata: {
          ...metadata,
          sourceUrl: url,
          pageTitle: fetchResult.title,
          fetchedBy: "url_fetch-node",
          ingestedAt: new Date().toISOString(),
        },
      });

      const ingestResult = JSON.parse(
        (ingestResponse.content as any[])[0]?.text ?? "{}"
      ) as { success: boolean; chunksStored: number; filename: string };

      result = {
        success: true,
        chunksStored: ingestResult.chunksStored,
        filename: derivedFilename,
        source: "url_fetch-node",
      };
    }

    console.log(`[ingest-url] Done via "${result.source}": ${result.chunksStored} chunks`);
    res.json(result);

  } catch (err: any) {
    const status = err?.status ?? 500;
    res.status(status).json({ error: err?.message ?? "URL ingest failed" });
  }
});

export default router;
