#!/usr/bin/env bash
#
# Refresh the bundled OpenAPI snapshot from the local Paperclip server source, then verify.
# Run this whenever Paperclip adds or changes API endpoints. See RUNBOOK.md for the full flow
# (including the optional doc-enrichment refresh, which needs Claude Code).
#
# Usage:
#   npm run sync
#
# Note: the live transport already auto-syncs at runtime by fetching /api/openapi.json from the
# target instance. This script only refreshes the OFFLINE fallback snapshot committed to the repo.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> 1/4 Regenerating spec/openapi.json + spec/operations-index.json from the server source"
npm run --silent gen:spec

echo "==> 2/4 Verifying coverage (every operation maps to a unique tool)"
npm run --silent check:coverage

echo "==> 3/4 Building"
npm run --silent build

echo "==> 4/4 Testing"
npm test --silent

echo
echo "Sync complete."
echo "  - Review changes:  git -C \"$(pwd)\" diff --stat spec/"
echo "  - New endpoints are auto-covered as tools (no code changes needed)."
echo "  - To refresh doc-derived descriptions (spec/enrichment.json), see RUNBOOK.md."
