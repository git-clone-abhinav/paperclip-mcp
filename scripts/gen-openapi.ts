/**
 * Generate the bundled OpenAPI snapshot from the Paperclip server source.
 *
 * The server builds its OpenAPI 3.0 document from the same zod schemas its routes
 * use (see paperclip/server/src/routes/openapi.ts -> buildOpenApiDocument).
 * We import that builder directly and dump the result to spec/openapi.json so the
 * MCP server has an offline fallback when a live instance is unreachable.
 *
 * Run with the paperclip workspace's tsx so the builder's workspace imports resolve:
 *   paperclip/server/node_modules/.bin/tsx paperclip-mcp/scripts/gen-openapi.ts
 *
 * Override the source module with PAPERCLIP_OPENAPI_MODULE if the layout differs.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverOpenApiModule =
    process.env.PAPERCLIP_OPENAPI_MODULE ??
    resolve(here, "../../paperclip/server/src/routes/openapi.ts");

  const mod = await import(serverOpenApiModule);
  const build = mod.buildOpenApiDocument ?? mod.buildOpenApiSpec;
  if (typeof build !== "function") {
    throw new Error(
      `No buildOpenApiDocument/buildOpenApiSpec export found in ${serverOpenApiModule}`,
    );
  }

  const doc = build();
  const pathCount = Object.keys(doc.paths ?? {}).length;
  let opCount = 0;
  for (const item of Object.values(doc.paths ?? {})) {
    for (const method of Object.keys(item as Record<string, unknown>)) {
      if (["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) {
        opCount++;
      }
    }
  }

  const specDir = resolve(here, "../spec");
  mkdirSync(specDir, { recursive: true });

  const out = resolve(specDir, "openapi.json");
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);

  // Also emit a compact operations index (used by the doc-enrichment workflow and tooling).
  const methods = ["get", "post", "put", "patch", "delete"];
  const index: Array<Record<string, unknown>> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, any>)) {
      if (!methods.includes(method)) continue;
      index.push({
        key: `${method.toUpperCase()} ${path}`,
        method,
        path,
        summary: op?.summary ?? "",
        tags: op?.tags ?? [],
        actor: op?.["x-paperclip-authorization"]?.actor ?? null,
      });
    }
  }
  const indexOut = resolve(specDir, "operations-index.json");
  writeFileSync(indexOut, `${JSON.stringify(index, null, 2)}\n`);

  console.log(`Wrote ${out}`);
  console.log(`Wrote ${indexOut}`);
  console.log(`  openapi: ${doc.openapi}  title: ${doc.info?.title}  version: ${doc.info?.version}`);
  console.log(`  paths: ${pathCount}  operations: ${opCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
