# Runbook: keeping paperclip-mcp in sync with the Paperclip API

This MCP server is **spec-driven**: tools are generated from Paperclip's OpenAPI document, not
hand-written. New or changed endpoints flow through with little or no manual work.

## How endpoints reach the model

1. **At runtime (automatic).** With the default `auto` / `live` spec source, the server fetches
   `GET /api/openapi.json` from the target instance on startup and builds tools from it. Point it
   at an updated instance and the new endpoints appear immediately — no rebuild.
2. **Offline fallback (snapshot).** `spec/openapi.json` is a committed snapshot used when the live
   instance is unreachable (or when `PAPERCLIP_OPENAPI_SOURCE=bundled`). This is the only thing that
   needs periodic regeneration.

So: **the live path already self-syncs.** The steps below refresh the committed snapshot and the
optional doc-derived descriptions.

---

## When Paperclip adds / changes endpoints

### 1. Refresh the bundled snapshot + verify (one command)

```sh
npm run sync
```

This runs, in order:
- `npm run gen:spec` — regenerates `spec/openapi.json` **and** `spec/operations-index.json` from the
  local Paperclip server source (`paperclip/server/src/routes/openapi.ts` → `buildOpenApiDocument()`).
- `npm run check:coverage` — asserts every operation maps to exactly one valid, unique tool name.
- `npm run build` and `npm test`.

Requires the sibling `paperclip/` checkout with deps installed (`pnpm -C ../paperclip install`).
Override the source module path with `PAPERCLIP_OPENAPI_MODULE` if the layout differs.

Then review and commit:

```sh
git diff --stat spec/
git add spec/openapi.json spec/operations-index.json
git commit -m "chore: refresh Paperclip OpenAPI snapshot"
```

New endpoints are now covered as tools. **No source changes are required** — that's the point of the
spec-driven design.

### 2. (Optional) Refresh doc-derived descriptions

Tool descriptions fall back to the spec's `summary`. For richer, model-facing descriptions we layer
`spec/enrichment.json`, produced from the reference docs by a Claude Code workflow.

In Claude Code, run the saved workflow, then merge its result:

```
# 1. Run the enrichment workflow (fans out one agent per reference doc):
Workflow({ scriptPath: "scripts/doc-enrichment.workflow.js" })

# 2. Save the workflow's result JSON (or its task output file), then:
node scripts/merge-enrichment.mjs <workflow-result.json>
```

`merge-enrichment.mjs` drops any keys that don't exist in the current `operations-index.json`, so the
enrichment can never drift from the real API. Re-run `npm run check:coverage` and commit
`spec/enrichment.json`.

> Enrichment is purely additive polish. If you skip it, tools still work with spec summaries.

---

## Quick checks

| Goal | Command |
|---|---|
| Regenerate snapshot + index | `npm run gen:spec` |
| Verify every op → unique tool | `npm run check:coverage` |
| Full refresh + build + test | `npm run sync` |
| Run the server (stdio) | `npm run dev` |
| List tools without an instance | `PAPERCLIP_OPENAPI_SOURCE=bundled npm run dev` |

## Files involved

- `scripts/gen-openapi.ts` — snapshot + index generator.
- `scripts/check-coverage.ts` — coverage/uniqueness guard.
- `scripts/doc-enrichment.workflow.js` — Claude Code workflow for descriptions.
- `scripts/merge-enrichment.mjs` — merges workflow output → `spec/enrichment.json`.
- `scripts/sync.sh` — orchestrates the snapshot refresh + verification.
