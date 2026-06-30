# Changelog

All notable changes to **paperclip-mcp** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Maintain the `[Unreleased]` section from
git commits (`git log --oneline <last-tag>..HEAD`); on release, rename it to the version + date.

## [Unreleased]

### Added
- Spec-driven tool generation: builds one MCP tool per Paperclip OpenAPI operation
  (345 paths / 423 operations / ~30 namespaces); deterministic, unique tool names from method + path.
- **Gateway mode (default)** — progressive tool discovery via meta-tools `paperclip_search_tools`,
  `paperclip_inspect_tool`, `paperclip_call_tool`, plus a raw `paperclip_request` escape hatch, so the
  model never loads the full tool surface at once.
- `direct` and `hybrid` tool-exposure modes (`PAPERCLIP_MCP_MODE`) with tag/regex filtering.
- Search surfaces all namespaces: the `tag` parameter enumerates every schema tag, and results include
  a tag directory with counts.
- Risk model (read/write/destructive) with confirm-before-DELETE; result-size truncation.
- OpenAPI source resolution: live `/api/openapi.json` with bundled snapshot fallback
  (`PAPERCLIP_OPENAPI_SOURCE`), so the server auto-syncs with a running instance.
- Bearer auth + optional `X-Paperclip-Run-Id`; configurable via env and CLI flags.
- Transports: stdio (default, bin) and stateless Streamable HTTP (`/mcp` + `/health`).
- Optional doc-derived tool descriptions (`spec/enrichment.json`).
- Reusable upkeep tooling: `npm run sync`, `scripts/gen-openapi.ts`, `scripts/check-coverage.ts`,
  `scripts/doc-enrichment.workflow.js`, `scripts/merge-enrichment.mjs`; documented in `RUNBOOK.md`.
- Tests: vitest unit (tools, registry) + stdio integration (gateway and direct modes).
- Docs: `README.md`, `RUNBOOK.md`, `CLAUDE.md`, `.env.example`, `NOTES.md`.
- `prepare` lifecycle script builds `dist/` automatically on `npm install`, so installing from a
  local path or git (e.g. into a Hermes/Pi agent) needs no manual build step.

### Notes
- Built on `@modelcontextprotocol/sdk` 1.29 (low-level `Server`).

## Project history (pre-implementation)
- Build notes, OpenAPI generation script, and initial OpenAPI spec.
- Initial scaffold of the paperclip-mcp submodule.
