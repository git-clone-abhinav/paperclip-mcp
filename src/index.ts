#!/usr/bin/env node
/** paperclip-mcp entrypoint: load config + spec, build tools, connect a transport. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { describeConfig, loadConfig } from "./config.js";
import { PaperclipClient } from "./http-client.js";
import { startHttpTransport } from "./http.js";
import { createLogger } from "./logger.js";
import { createPaperclipMcp } from "./server.js";
import { loadEnrichment, loadSpec } from "./spec-loader.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("paperclip-mcp");
  log.info(
    `Starting paperclip-mcp v${config.serverVersion}`,
    JSON.stringify(describeConfig(config)),
  );

  const { spec, origin } = await loadSpec(config, log);
  const enrichment = loadEnrichment(log);
  const client = new PaperclipClient(config, log);
  const app = createPaperclipMcp({ config, client, spec, enrichment, log });

  log.info(
    `OpenAPI source: ${origin} — ${spec.info?.title ?? "Paperclip API"} v${spec.info?.version ?? "?"}. ` +
      `Mode: ${app.stats.mode}. Operations: ${app.stats.totalOperations} across ${app.stats.tags} tags; ` +
      `endpoint tools exposed: ${app.stats.exposedEndpointTools}; total tools listed: ${app.stats.totalTools}.`,
  );

  if (config.transport === "http") {
    await startHttpTransport(app, config, log);
  } else {
    const transport = new StdioServerTransport();
    await app.buildServer().connect(transport);
    log.info("stdio transport connected; server ready.");
  }
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
