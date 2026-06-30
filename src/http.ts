/** Optional Streamable HTTP transport (stateless: a fresh server per request). */
import { createServer as createHttpServer, type IncomingMessage } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { PaperclipMcpConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { PaperclipMcp } from "./server.js";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

export async function startHttpTransport(
  app: PaperclipMcp,
  cfg: PaperclipMcpConfig,
  log: Logger,
): Promise<void> {
  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tools: app.stats.totalTools }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Send MCP requests to POST /mcp." }));
      return;
    }

    try {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      const server = app.buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error("HTTP request handling failed", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(cfg.httpPort, cfg.httpHost, () => resolve());
  });
  log.info(`HTTP (Streamable) transport listening at http://${cfg.httpHost}:${cfg.httpPort}/mcp`);
}
