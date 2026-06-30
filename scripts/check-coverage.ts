/**
 * Coverage guard: verify that every operation in the bundled OpenAPI snapshot maps to
 * exactly one valid, unique MCP tool name, and report doc-enrichment coverage.
 *
 * Reusable regression check — run after regenerating the spec (see RUNBOOK.md):
 *   npm run check:coverage
 *
 * Exits non-zero if any operation is unmapped, any tool name is invalid, or any name collides.
 */
import { readFileSync } from "node:fs";

import { bundledSpecPath, bundledEnrichmentPath } from "../src/paths.js";
import type { OpenApiDocument } from "../src/openapi-types.js";
import { HTTP_METHODS } from "../src/openapi-types.js";
import { buildOperations, operationKey } from "../src/tools.js";
import type { EnrichmentMap } from "../src/spec-loader.js";

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function countSpecOperations(spec: OpenApiDocument): number {
  let n = 0;
  for (const item of Object.values(spec.paths ?? {})) {
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      if (item[method]) n++;
    }
  }
  return n;
}

function main(): void {
  const spec = JSON.parse(readFileSync(bundledSpecPath, "utf8")) as OpenApiDocument;
  let enrichment: EnrichmentMap = {};
  try {
    enrichment = JSON.parse(readFileSync(bundledEnrichmentPath, "utf8")) as EnrichmentMap;
  } catch {
    // enrichment is optional
  }

  const specOpCount = countSpecOperations(spec);
  const ops = buildOperations(spec, enrichment);

  const problems: string[] = [];

  // 1. Every spec operation produced a tool.
  if (ops.length !== specOpCount) {
    problems.push(`Operation count mismatch: spec has ${specOpCount}, built ${ops.length} tools.`);
  }

  // 2. Tool names valid + unique.
  const seen = new Map<string, string>();
  for (const op of ops) {
    if (!NAME_RE.test(op.name)) {
      problems.push(`Invalid tool name "${op.name}" for ${op.method} ${op.path}`);
    }
    const prior = seen.get(op.name);
    if (prior) {
      problems.push(`Duplicate tool name "${op.name}": ${prior} AND ${op.method} ${op.path}`);
    } else {
      seen.set(op.name, `${op.method} ${op.path}`);
    }
  }

  // 3. Enrichment keys all reference real operations.
  const validKeys = new Set(ops.map((op) => operationKey(op.method, op.path)));
  let staleEnrichment = 0;
  for (const key of Object.keys(enrichment)) {
    if (!validKeys.has(key)) staleEnrichment++;
  }
  const enrichedCount = ops.filter((op) =>
    Object.prototype.hasOwnProperty.call(enrichment, operationKey(op.method, op.path)),
  ).length;

  console.log(`Spec operations:      ${specOpCount}`);
  console.log(`Tools generated:      ${ops.length}`);
  console.log(`Unique tool names:    ${seen.size}`);
  console.log(
    `Doc-enriched tools:   ${enrichedCount}/${ops.length} (${((100 * enrichedCount) / ops.length).toFixed(1)}%)`,
  );
  if (staleEnrichment > 0) {
    console.log(`Stale enrichment keys: ${staleEnrichment} (reference operations not in the spec)`);
  }

  if (problems.length) {
    console.error(`\nFAIL — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nPASS — every operation maps to a unique, valid tool name.");
}

main();
