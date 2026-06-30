# paperclip-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the **entire
[Paperclip](https://docs.paperclip.ing) control-plane REST API** to MCP clients (Claude Code,
Claude Desktop, Cursor, …).

It is **spec-driven**: tools are generated from Paperclip's own OpenAPI document
(`GET /api/openapi.json`, built from the server's zod schemas), so all ~420 endpoints across ~30
namespaces are covered and stay in sync automatically — no hand-written tool per endpoint.

This repo is a submodule of
[`paperclip-development-stack`](https://github.com/git-clone-abhinav/paperclip-development-stack),
alongside the `paperclip` app and `companies` catalog.

## How it works

```
MCP client ──stdio/http──▶ paperclip-mcp ──HTTP(Bearer)──▶ Paperclip /api
                              │
                              ├─ loads OpenAPI (live instance, else bundled snapshot)
                              ├─ builds a tool registry (one tool per operation)
                              └─ serves a small set of meta-tools (gateway mode)
```

### Gateway mode (default) — progressive tool discovery

Dumping ~420 tool schemas into the model context is slow, expensive, and hurts tool selection.
Instead, by default the server exposes a **tool registry behind meta-tools** and the model discovers
what it needs per task:

| Meta-tool | Purpose |
|---|---|
| `paperclip_search_tools` | Find relevant endpoints by keyword/namespace. Returns ranked results **and the full tag directory**. Start here. |
| `paperclip_inspect_tool` | Get one tool's full description, input schema, risk level, and auth actor. |
| `paperclip_call_tool` | Execute a tool by name with arguments. Destructive (DELETE) calls require `confirm:true`. |
| `paperclip_request` | Raw escape hatch: call any `method + path` directly (optional). |

The full surface is always reachable through `call_tool` / `request` — the model just isn't forced
to load all of it at once.

### Other modes

- `direct` — every (filtered) endpoint is registered as its own tool, plus the meta-tools. Use when
  your client handles large tool counts or you've narrowed the surface with filters.
- `hybrid` — only allowlisted endpoints (`PAPERCLIP_MCP_TAGS` / `PAPERCLIP_MCP_INCLUDE`) become tools,
  plus the meta-tools.

Set with `PAPERCLIP_MCP_MODE` or `--mode`.

## Install & build

```sh
npm install   # runs the `prepare` script, which builds dist/ automatically
```

There is **no separate build step** for consumers: the `prepare` lifecycle script runs `tsc` on
`npm install`, so `dist/` is ready right after install. (`npm run build` is still available to rebuild
manually.) The bundled `spec/openapi.json` ships too, so it works offline out of the box.

## Install into an agent (Hermes / Pi / local)

Because of the `prepare` script, you do **not** clone-then-build manually. Pick whichever fits the
agent's "install from local" flow:

```sh
# A) As a dependency from a local path or git — npm builds dist/ during install:
npm install /path/to/paperclip-mcp
npm install git+https://github.com/git-clone-abhinav/paperclip-mcp.git
#   then run it via the bin:
npx paperclip-mcp           # or: node node_modules/.bin/paperclip-mcp

# B) Clone + install (dist/ is built by prepare):
git clone <repo> && cd paperclip-mcp && npm install
node dist/index.js          # or: npx paperclip-mcp

# C) Run from source, no build at all (handy in dev):
npm run dev                 # tsx src/index.ts
```

In an agent's MCP config, the launch command is then either `node /abs/.../dist/index.js` or
`npx -y paperclip-mcp`, with the `PAPERCLIP_*` env vars below.

## Run

```sh
# stdio (for Claude Desktop / Claude Code), pointed at a local instance:
PAPERCLIP_API_BASE_URL=http://localhost:3100 PAPERCLIP_API_KEY=pcp_board_xxx npm run dev

# Streamable HTTP transport:
PAPERCLIP_MCP_TRANSPORT=http npm run dev      # POST http://127.0.0.1:3333/mcp

# Browse tools with no running instance (uses the bundled snapshot):
PAPERCLIP_OPENAPI_SOURCE=bundled npm run dev
```

### Claude Desktop / Claude Code config

```json
{
  "mcpServers": {
    "paperclip": {
      "command": "node",
      "args": ["/absolute/path/to/paperclip-mcp/dist/index.js"],
      "env": {
        "PAPERCLIP_API_BASE_URL": "http://localhost:3100",
        "PAPERCLIP_API_KEY": "pcp_board_your_token"
      }
    }
  }
}
```

## Authentication

The server sends `Authorization: Bearer <PAPERCLIP_API_KEY>` on every request. Use a **board API key**
(`pcp_board_…`) for operator/automation access, or an **agent API key / JWT** for agent-scoped access.
A `local_trusted` instance with private exposure needs no key. `PAPERCLIP_RUN_ID` sets the optional
`X-Paperclip-Run-Id` header. See [Paperclip API auth](https://docs.paperclip.ing/reference/api/authentication).

## Configuration

All options are environment variables (see [`.env.example`](./.env.example)); key ones:

| Variable | Default | Description |
|---|---|---|
| `PAPERCLIP_API_BASE_URL` | `http://localhost:3100` | Instance origin |
| `PAPERCLIP_API_KEY` | — | Bearer token |
| `PAPERCLIP_MCP_MODE` | `gateway` | `gateway` \| `direct` \| `hybrid` |
| `PAPERCLIP_OPENAPI_SOURCE` | `auto` | `auto` \| `live` \| `bundled` |
| `PAPERCLIP_MCP_TAGS` / `_EXCLUDE_TAGS` | — | Tag allow/deny (direct/hybrid) |
| `PAPERCLIP_MCP_INCLUDE` / `_EXCLUDE` | — | Regex allow/deny on tool name/path |
| `PAPERCLIP_MCP_CONFIRM_DESTRUCTIVE` | `true` | Require `confirm:true` for DELETE |
| `PAPERCLIP_MCP_MAX_RESULT_CHARS` | `50000` | Truncate large responses |
| `PAPERCLIP_MCP_TRANSPORT` | `stdio` | `stdio` \| `http` |

## Keeping in sync with the API

The live transport auto-syncs at runtime. To refresh the committed offline snapshot when Paperclip
adds endpoints:

```sh
npm run sync   # regenerate snapshot + index, verify coverage, build, test
```

See [`RUNBOOK.md`](./RUNBOOK.md) for the full flow, including refreshing doc-derived descriptions.

## Develop

```sh
npm test                # vitest (unit + stdio integration against a mock API)
npm run check:coverage  # assert every operation maps to a unique, valid tool
npm run typecheck
```

## Layout

```
src/
  index.ts        entrypoint: config -> spec -> tools -> transport
  config.ts       env/CLI configuration
  spec-loader.ts  live fetch + bundled fallback + enrichment loader
  tools.ts        OpenAPI operation -> tool (naming, input schema, arg routing, risk)
  registry.ts     namespaces (tags) + keyword search
  server.ts       MCP wiring: meta-tools, modes, risk gating, result compression
  http-client.ts  Bearer-authed fetch wrapper
  http.ts         Streamable HTTP transport
spec/
  openapi.json          bundled OpenAPI snapshot (fallback)
  operations-index.json compact op index (tooling + enrichment)
  enrichment.json       doc-derived tool descriptions (optional)
scripts/          gen-openapi, check-coverage, sync, doc-enrichment workflow + merge
```
