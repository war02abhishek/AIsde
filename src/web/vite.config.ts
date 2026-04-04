import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config with proxy setup
 *
 * WHY PROXY?
 * The React app runs on http://localhost:5173 (Vite dev server)
 * The Express backend runs on http://localhost:3000
 *
 * Without proxy, fetch("/chat") would hit localhost:5173/chat → 404
 * With proxy, fetch("/chat") gets forwarded to localhost:3000/chat ✅
 *
 * This means in api.ts we just write fetch("/chat") — no hardcoded ports.
 * In production, you'd put a real reverse proxy (nginx/ALB) in front.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/chat":   "http://localhost:3000",
      "/ingest": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/eval":        "http://localhost:3000",
      "/ingest-url":  "http://localhost:3000",
    },
  },
});
