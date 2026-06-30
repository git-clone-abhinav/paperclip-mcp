# CLAUDE.md — paperclip-mcp

Guidance for Claude Code working in this repository. Read this first, then the linked docs.

## What this is

An MCP (Model Context Protocol) server that exposes the **entire Paperclip control-plane REST API**
as MCP tools. It is **spec-driven**: tools are generated from Paperclip's OpenAPI document
(`GET /api/openapi.json`), not hand-written. Standalone npm package (own `node_modules`), not part of
the Paperclip pnpm monorepo. **This repo is open source — never commit absolute paths, usernames,
secrets, or internal directory layouts.** Use relative paths and `<WORKSPACE>` placeholders.

## Where to look (don't duplicate these here)

- **`README.md`** — product overview, modes, configuration, client setup.
- **`NOTES.md`** — build notes, design decisions, learnings, and the job checklist (working memory).
- **`RUNBOOK.md`** — how to keep tools in sync when Paperclip adds/changes endpoints.
- **`CHANGELOG.md`** — notable changes per version; keep it updated from git commits (see below).
- **`.env.example`** — every configuration variable.
- **Durable cross-session memory** lives in the Claude project memory index (`memory/MEMORY.md` under
  the project's `.claude` dir): see `paperclip-mcp-server`, `mcp-gateway-tool-discovery`,
  `reusable-update-scripts`. Update those when a decision or preference changes.

## Architecture (one line each)

- `src/index.ts` entrypoint · `src/config.ts` env/CLI · `src/spec-loader.ts` live+bundled spec
- `src/tools.ts` operation→tool (naming, input schema, arg routing, risk) · `src/registry.ts` tags+search
- `src/server.ts` MCP wiring (gateway meta-tools, modes, risk gating) · `src/http-client.ts` · `src/http.ts`
- `spec/` bundled snapshot + ops index + enrichment · `scripts/` gen/coverage/sync/enrichment

Default **gateway mode** exposes meta-tools (`search`/`inspect`/`call`) for progressive tool discovery
instead of dumping ~420 schemas. See README for `direct`/`hybrid`.

## Commands

```sh
npm install
npm run dev            # run (stdio); add PAPERCLIP_MCP_TRANSPORT=http for HTTP
npm test               # vitest unit + stdio integration
npm run typecheck
npm run check:coverage # assert every operation maps to a unique, valid tool
npm run sync           # regenerate snapshot+index -> verify -> build -> test
```

## Rules

- **Spec-driven first.** New endpoints come from the spec — prefer `npm run sync` over editing tools
  by hand. Don't add per-endpoint code unless an endpoint needs special handling.
- **No leaked paths.** Scan before committing: `grep -rIn -e "/Users/" -e "$USER" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist`.
- **Keep contracts in sync.** If you touch tool naming / input-schema logic, update tests and run
  `npm run check:coverage`.
- **Update CHANGELOG.md** for every notable change, grouped under `[Unreleased]` until release. Derive
  entries from commit messages: `git log --oneline <last-tag>..HEAD`.

## Changelog upkeep

After committing notable work, add a bullet under `## [Unreleased]` in `CHANGELOG.md`
(Added/Changed/Fixed/Removed). On release, rename `[Unreleased]` to the version + date and start a new
empty `[Unreleased]`. Source of truth is git history (`git log`).
