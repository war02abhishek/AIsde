/**
 * url_fetch.ts — MCP Tool: url_fetch
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHAT DOES THIS TOOL DO?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Fetches a URL and returns clean readable text — no HTML tags,
 * no scripts, no nav bars. Just the actual content.
 *
 * WHY STRIP HTML?
 *   Raw HTML:   "<div class='nav'><a href='/'>Home</a>...</div>
 *                <p>RAG stands for Retrieval Augmented Generation</p>"
 *   Clean text: "RAG stands for Retrieval Augmented Generation"
 *
 *   Embedding raw HTML produces terrible vectors because the HTML
 *   tags add noise that has nothing to do with the content meaning.
 *   Clean text → better embeddings → better retrieval.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * HOW HTML PARSING WORKS (cheerio):
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * cheerio is a server-side jQuery — it parses HTML and lets you
 * query/manipulate it with CSS selectors.
 *
 * Steps:
 *   1. fetch(url)              → raw HTML string
 *   2. cheerio.load(html)      → jQuery-like $ object
 *   3. $("script,style").remove() → strip noise elements
 *   4. $("body").text()        → extract all visible text
 *   5. clean whitespace        → normalize spaces/newlines
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * TOOL INPUT / OUTPUT:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Input:
 *   { "url": "https://example.com/docs", "maxChars": 10000 }
 *
 * Output:
 *   {
 *     "url": "https://example.com/docs",
 *     "title": "Page Title",
 *     "text": "Clean readable text content...",
 *     "charCount": 4521
 *   }
 */

// Node 18+ has built-in fetch globally — no import needed
// node-fetch v3 is ESM-only and breaks CommonJS (ts-node-dev uses CommonJS)
// Built-in fetch is identical API, zero extra dependencies
import * as cheerio from "cheerio";

// Max characters to return — prevents huge pages from blowing up the context
const DEFAULT_MAX_CHARS = 15000;

export const urlFetchTool = {
  name: "url_fetch",
  description:
    "Fetches a URL and returns clean readable text content (HTML stripped). " +
    "Use this to read web pages, documentation, or articles before ingesting them. " +
    "Returns the page title and text content.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (must start with http:// or https://)",
      },
      maxChars: {
        type: "number",
        description: `Maximum characters to return (default: ${DEFAULT_MAX_CHARS})`,
        default: DEFAULT_MAX_CHARS,
      },
    },
    required: ["url"],
  },
};

/**
 * Handles a url_fetch tool call
 *
 * @param args - { url, maxChars }
 * @returns    - MCP content array with { url, title, text, charCount }
 *
 * Example:
 *   handleUrlFetch({ url: "https://en.wikipedia.org/wiki/RAG" })
 *   → { url: "...", title: "Retrieval-augmented generation", text: "RAG is...", charCount: 8432 }
 */
export async function handleUrlFetch(args: { url: string; maxChars?: number }) {
  const { url, maxChars = DEFAULT_MAX_CHARS } = args;

  console.log(`\n${"-".repeat(50)}`);
  console.log(`[url_fetch] 🌐 STEP 1 — Starting fetch`);
  console.log(`[url_fetch] URL      : ${url}`);
  console.log(`[url_fetch] Max chars: ${maxChars}`);

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(`Invalid URL: must start with http:// or https://`);
  }

  console.log(`[url_fetch] 📡 STEP 2 — Sending HTTP request...`);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AIsde-RAG-Bot/1.0)" },
  });

  console.log(`[url_fetch] ✅ HTTP ${response.status} ${response.statusText}`);
  console.log(`[url_fetch] Content-Type: ${response.headers.get("content-type")}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  console.log(`[url_fetch] 📄 STEP 3 — Raw HTML size: ${html.length} chars`);

  const $ = cheerio.load(html);
  const title = $("title").text().trim() || $("h1").first().text().trim() || "Untitled";
  console.log(`[url_fetch] 📝 Page title: "${title}"`);

  console.log(`[url_fetch] 🧹 STEP 4 — Stripping noise elements (script, style, nav, header, footer...)`);
  $("script, style, nav, header, footer, aside, noscript, iframe").remove();

  const rawText = $("body").text();
  console.log(`[url_fetch] 📊 Raw text after strip: ${rawText.length} chars`);

  const cleanText = rawText
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);

  console.log(`[url_fetch] ✨ STEP 5 — Clean text: ${cleanText.length} chars (truncated to ${maxChars})`);
  console.log(`[url_fetch] 👁️  Preview: "${cleanText.slice(0, 150).replace(/\n/g, " ")}..."`);
  console.log(`${"-".repeat(50)}\n`);

  const result = { url, title, text: cleanText, charCount: cleanText.length };
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}
