/**
 * Claude Code workflow: enrich MCP tool descriptions from the Paperclip reference docs.
 *
 * This is NOT a plain node script — run it with Claude Code's Workflow tool:
 *   Workflow({ scriptPath: "scripts/doc-enrichment.workflow.js" })
 *
 * It fans out one agent per reference doc (paperclip-docs/docs/reference/api/*.md), extracts
 * per-endpoint descriptions keyed by "METHOD /api/path", and returns an { enrichment } map.
 * Feed that result to scripts/merge-enrichment.mjs to write spec/enrichment.json.
 *
 * Edit DOC_DIR / OPS_INDEX / DOCS if the workspace layout or doc set changes.
 */
export const meta = {
  name: "paperclip-mcp-doc-enrichment",
  description:
    "Enrich Paperclip MCP tool descriptions by extracting per-endpoint detail from the reference API docs in parallel",
  phases: [{ title: "Enrich", detail: "one agent per reference doc -> structured descriptions" }],
};

// Provide ABSOLUTE paths for your checkout — either pass them as Workflow args:
//   Workflow({ scriptPath: "scripts/doc-enrichment.workflow.js",
//              args: { docDir: "/abs/paperclip-docs/docs/reference/api",
//                      opsIndexPath: "/abs/paperclip-mcp/spec/operations-index.json" } })
// …or replace the <WORKSPACE> placeholder below with your absolute workspace root.
const cfg = typeof args === "object" && args ? args : {};
const DOC_DIR = cfg.docDir || "<WORKSPACE>/paperclip-docs/docs/reference/api";
const OPS_INDEX = cfg.opsIndexPath || "<WORKSPACE>/paperclip-mcp/spec/operations-index.json";
const DOCS = [
  "activity.md", "adapters.md", "agents.md", "approvals.md", "authentication.md",
  "companies.md", "costs.md", "dashboard.md", "goals-and-projects.md", "instance-admin.md",
  "issues.md", "plugins.md", "resource-memberships.md", "routines.md", "secrets.md",
  "teams-catalog.md",
];

const ENRICH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    enrichments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", description: 'Exact "METHOD /api/path" key copied from the operations index' },
          description: { type: "string", description: "Concise model-facing description, <60 words" },
          usage: { type: "string", description: "Optional: when/how to use, ordering, side effects" },
        },
        required: ["key", "description"],
      },
    },
  },
  required: ["enrichments"],
};

phase("Enrich");

const results = await parallel(
  DOCS.map((doc) => () =>
    agent(
      `You enrich MCP tool descriptions for the Paperclip REST API control plane.\n\n` +
        `1. Read the operations index JSON at: ${OPS_INDEX}\n` +
        `   It is an array of { key: "METHOD /api/path", method, path, summary, tags, actor }.\n` +
        `2. Read the reference doc at: ${DOC_DIR}/${doc}\n\n` +
        `For every API operation this doc documents, find its EXACT key in the index and write a concise, model-facing description.\n` +
        `Rules:\n` +
        `- Only emit keys that exist verbatim in the index. Do not invent paths or params.\n` +
        `- description < 60 words: what it does, key params/body fields, gotchas (company scoping, X-Paperclip-Run-Id, enums, 409 preconditions).\n` +
        `- usage (optional): ordering vs other endpoints, side effects, idempotency.\n` +
        `- Skip operations not covered by this doc.\n` +
        `Return { enrichments: [...] }.`,
      { label: `enrich:${doc}`, phase: "Enrich", schema: ENRICH_SCHEMA },
    ),
  ),
);

const enrichment = {};
let raw = 0;
for (const r of results) {
  if (!r || !Array.isArray(r.enrichments)) continue;
  for (const e of r.enrichments) {
    if (!e || typeof e.key !== "string" || typeof e.description !== "string") continue;
    raw++;
    const entry = { description: e.description.trim() };
    if (e.usage && typeof e.usage === "string" && e.usage.trim()) entry.usage = e.usage.trim();
    enrichment[e.key.trim()] = entry;
  }
}

log(`Collected ${Object.keys(enrichment).length} enriched keys from ${DOCS.length} docs (${raw} raw entries)`);

return { enrichment };
