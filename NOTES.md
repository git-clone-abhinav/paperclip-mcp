# paperclip-mcp — Build Notes & Checklist

Living doc. Learnings + job checklist for building the Paperclip MCP server.
Last updated: 2026-06-30.

## Goal

Wrap the **entire** Paperclip REST API as an MCP server so MCP clients (Claude Code,
Claude Desktop, Cursor, …) can call every endpoint as a tool.

## Key learnings (source of truth)

### API shape
- **Base path**: always `/api`. Local dev: `http://localhost:3100/api`.
- **Auth**: `Authorization: Bearer <token>` for every authed call.
  - Board API keys: prefix `pcp_board_` (humans/automation).
  - Agent API keys: from `POST /api/agents/:id/keys` (agent-scoped, single company).
  - Local agent JWTs: signed runtime tokens.
  - `local_trusted` deployment with `server.exposure=private` needs **no token** (implicit board actor).
- **`X-Paperclip-Run-Id`** header: read on mutating requests during agent runs
  (issue comments, checkout, run-linked actions). Optional, pass-through.
- **Request body**: JSON (`Content-Type: application/json`) unless a route documents multipart.
- **Error shape**: `{ "error": "message" }`, sometimes `{ "error", "details" }`.
- **Status codes**: 400 validation, 401 unauthenticated, 403 forbidden, 404 not found,
  409 conflict (locked/owned/revoked), 422 business-rule reject, 503 db down, 500 internal.
- **Company scoping is a hard invariant**: most routes are `/api/companies/{companyId}/...`.
  Wrong company → 403/404.

### The big win: server already emits OpenAPI
- `server/src/routes/openapi.ts` (4713 lines) builds a full OpenAPI 3.0 doc from the
  same zod schemas the routes use. Exported `buildOpenApiDocument()`.
- Served live at **`GET /api/openapi.json`**. CLI: `paperclipai access openapi`.
- ~692 method+path registrations (~340 operations) across tags: agents, issues, projects,
  companies, routines, goals, secrets, approvals, costs, activity, dashboard, plugins,
  adapters, teams-catalog, resource-memberships, instance-admin, …
- => **Design: spec-driven**. Don't hand-write 340 tools. Parse the spec, generate one
  MCP tool per operation dynamically. Guarantees complete coverage + stays in sync.

### Tooling
- `paperclip/` is a pnpm@9.15.4 monorepo (`type: module`). `tsx` ^4.22.4 available after install.
- Spec generation: import `buildOpenApiDocument` via tsx, dump to JSON. (Needs `pnpm install` first.)
- `paperclip-mcp/` is a **standalone** submodule repo (`git-clone-abhinav/paperclip-mcp`),
  sibling of `paperclip/`, own node_modules. Deps: `@modelcontextprotocol/sdk`, `zod`.

### Doc locations
- Full reference (authoritative, matches docs.paperclip.ing): `paperclip-docs/docs/reference/api/*.md`
  (issues.md 49KB, agents.md 32KB — these have request/response detail + examples).
- Shorter in-repo copy: `paperclip/docs/api/*.md`.

## Design decisions (final)
- **Spec source at runtime**: fetch live `/api/openapi.json` first; fall back to bundled
  `spec/openapi.json`. Modes via `PAPERCLIP_OPENAPI_SOURCE=auto|live|bundled`.
- **Spec facts confirmed**: 345 paths / **423 operations** / ~30 tags. No operationIds →
  derive deterministic tool names from `method_path` (≤64 chars, hash-disambiguated, all unique).
  Request bodies are inline JSON Schema (no $refs in inputs) → fed straight to tool `inputSchema`.
  Params declared in `parameters` (path/query). `x-paperclip-authorization.actor` (board/
  board_or_agent/public) + `instanceAdmin` → used for risk/elevated metadata.
- **Gateway mode is the DEFAULT** (per user feedback — production tool-surface management):
  expose only meta-tools `paperclip_search_tools` / `paperclip_inspect_tool` /
  `paperclip_call_tool` (+ optional `paperclip_request`). Progressive tool discovery: the model
  never loads ~420 schemas at once. `direct` mode = all (filtered) endpoint tools; `hybrid` =
  allowlisted only. `PAPERCLIP_MCP_MODE`.
- **search_tools surfaces ALL tags**: the `tag` param has an `enum` of every schema tag, and the
  response includes an `availableTags` directory with counts (per user request).
- **Risk model**: GET=read, POST/PUT/PATCH=write, DELETE=destructive. `call_tool` refuses
  destructive ops without `confirm:true` (`PAPERCLIP_MCP_CONFIRM_DESTRUCTIVE`). Result text
  truncated at `PAPERCLIP_MCP_MAX_RESULT_CHARS` (50k).
- **Transports**: stdio (bin) + Streamable HTTP (stateless, `/mcp` + `/health`).
- **SDK**: `@modelcontextprotocol/sdk` 1.29.0, low-level `Server` (sanctioned for advanced use).
- **Reusable upkeep**: `npm run sync` (gen snapshot+index → check coverage → build → test);
  `scripts/doc-enrichment.workflow.js` + `scripts/merge-enrichment.mjs` for descriptions. See RUNBOOK.md.

## Checklist (DONE)

- [x] `pnpm install` in paperclip/ — done (for spec gen)
- [x] Generate `spec/openapi.json` snapshot via buildOpenApiDocument() (+ operations-index.json)
- [x] Scaffold package: package.json, tsconfig.json, .gitignore, src/ layout
- [x] Config loader (env + CLI flags, modes)
- [x] HTTP client (Bearer auth, run-id, JSON, error normalization, timeout)
- [x] OpenAPI loader (live fetch + bundled fallback) + enrichment loader
- [x] Schema converter (OpenAPI params/body → JSON Schema tool input + arg routing)
- [x] Tool registrar (one tool per operation) + tag/regex filtering + risk metadata
- [x] Gateway meta-tools (search/inspect/call) + raw escape hatch
- [x] stdio transport + bin entry
- [x] Streamable HTTP transport (smoke-tested: /health + initialize)
- [x] Workflow: enriched 239/423 ops from 16 reference docs (0 invalid keys)
- [x] Vitest tests: 25 passing (unit: tools/registry; integration: stdio gateway+direct)
- [x] typecheck + build + coverage guard (423/423 unique) + stdio/http smoke
- [x] README, RUNBOOK, .env.example, reusable sync/gen/coverage/merge scripts

## Status: COMPLETE
All 423 endpoints reachable. Gateway default keeps context lean; direct/hybrid available.
Live transport auto-syncs; `npm run sync` refreshes the offline snapshot when the API changes.

## Possible follow-ups (not blocking)
- Embedding/router-model ranking in registry.ts (currently keyword + tag scoring).
- Per-endpoint examples in enrichment (only description/usage today).
- Multipart endpoints (asset/file upload) work via raw `body` but aren't typed as file inputs.
- Dev deps flagged npm-audit vulns (vite/esbuild transitive) — dev-only; review before publish.
