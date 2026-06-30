/**
 * Merge a doc-enrichment workflow result into spec/enrichment.json.
 *
 * The workflow (scripts/doc-enrichment.workflow.js) returns { enrichment: { "<KEY>": {...} } }.
 * Save that result JSON to a file and run:
 *
 *   node scripts/merge-enrichment.mjs <workflow-result.json>
 *
 * Accepts either the raw { enrichment: {...} } object, or a wrapper { result: { enrichment } }
 * (the shape of a Claude Code background task output file). Keys not present in the current
 * spec/operations-index.json are dropped, so the enrichment never drifts from the real API.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(here, "../spec");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/merge-enrichment.mjs <workflow-result.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(inputPath, "utf8"));
const enrichment = raw.result?.enrichment ?? raw.enrichment ?? raw;
if (!enrichment || typeof enrichment !== "object") {
  console.error("Could not find an enrichment object in the input file.");
  process.exit(1);
}

const index = JSON.parse(readFileSync(resolve(specDir, "operations-index.json"), "utf8"));
const validKeys = new Set(index.map((o) => o.key));

const out = {};
let kept = 0;
let dropped = 0;
for (const [k, v] of Object.entries(enrichment)) {
  const key = String(k).trim();
  if (!validKeys.has(key) || !v || typeof v.description !== "string") {
    dropped++;
    continue;
  }
  const entry = { description: v.description.trim() };
  if (v.usage && typeof v.usage === "string" && v.usage.trim()) entry.usage = v.usage.trim();
  out[key] = entry;
  kept++;
}

const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
const outPath = resolve(specDir, "enrichment.json");
writeFileSync(outPath, `${JSON.stringify(sorted, null, 2)}\n`);

console.log(`Wrote ${outPath}`);
console.log(`  kept ${kept}, dropped ${dropped} (invalid/unmatched keys)`);
console.log(`  coverage: ${kept}/${index.length} operations (${((100 * kept) / index.length).toFixed(1)}%)`);
