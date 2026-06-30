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

## Design decisions
- **Spec source at runtime**: fetch live `/api/openapi.json` from target instance first;
  fall back to bundled snapshot (`spec/openapi.json`) if unreachable. Override via env.
- **Tool per operation**: name from `operationId` (sanitized) or `method_path`.
  Input schema = path params + query params + requestBody merged into one object.
- **Tool-count control**: env filters `PAPERCLIP_MCP_TAGS`, `PAPERCLIP_MCP_INCLUDE`,
  `PAPERCLIP_MCP_EXCLUDE`. Default = expose all (honors "all available endpoints").
- **Always-on helper tools**: `paperclip_request` (raw escape hatch),
  `paperclip_list_endpoints`, `paperclip_describe_endpoint` (discovery).
- **Transports**: stdio (primary/bin) + optional Streamable HTTP (`--http` / env).
- **Config (env)**: `PAPERCLIP_API_BASE_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`,
  `PAPERCLIP_OPENAPI_URL`, filter vars, `PAPERCLIP_MCP_TRANSPORT`/`PORT`.

## Checklist

- [ ] `pnpm install` in paperclip/ (background) — needed for spec gen
- [ ] Generate `spec/openapi.json` snapshot via buildOpenApiDocument()
- [ ] Scaffold package: package.json, tsconfig.json, .gitignore, src/ layout
- [ ] Config loader (env)
- [ ] HTTP client (Bearer auth, run-id, JSON, error normalization)
- [ ] OpenAPI loader (live fetch + bundled fallback)
- [ ] Schema converter (OpenAPI params/body → JSON Schema tool input)
- [ ] Tool registrar (one tool per operation) + filtering
- [ ] Discovery + escape-hatch tools
- [ ] stdio transport + bin entry
- [ ] Streamable HTTP transport (optional)
- [ ] Workflow: enrich tool descriptions from 18 reference docs + coverage verify
- [ ] Vitest tests (schema conversion, registration, coverage)
- [ ] typecheck + build + stdio smoke test (list tools)
- [ ] README

## Open questions / risks
- ~340 tools may exceed some MCP clients' practical limits → mitigated by filters + helper tools.
- Spec `operationId`s: confirm they exist/are unique; else derive deterministic names from method+path.
- Some endpoints may be multipart (asset/file uploads) — handle or document as raw-request-only.
