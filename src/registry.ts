/**
 * In-memory tool registry: namespaces (tags) and keyword search over operations.
 *
 * This is the retrieval layer behind the gateway's progressive tool discovery. Scoring is
 * keyword + namespace (tag) based — deliberately dependency-free. An embedding/router model
 * could be layered on top later without changing the meta-tool contract.
 */
import type { ToolOperation } from "./tools.js";

export interface TagCount {
  tag: string;
  count: number;
}

export function collectTags(ops: ToolOperation[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const op of ops) {
    for (const tag of op.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export function tagList(ops: ToolOperation[]): string[] {
  return collectTags(ops).map((t) => t.tag);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface SearchHit {
  op: ToolOperation;
  score: number;
}

function scoreOperation(op: ToolOperation, queryTokens: string[], queryLower: string): number {
  const name = op.name.toLowerCase();
  const path = op.path.toLowerCase();
  const summary = op.summary.toLowerCase();
  const description = op.description.toLowerCase();
  const tags = op.tags.map((t) => t.toLowerCase());

  let score = 0;
  // Whole-phrase matches are strong signals.
  if (summary.includes(queryLower)) score += 6;
  if (name.includes(queryLower)) score += 4;
  if (path.includes(queryLower)) score += 4;

  for (const token of queryTokens) {
    if (tags.includes(token)) score += 5;
    if (name.includes(token)) score += 3;
    if (path.includes(token)) score += 2;
    if (summary.includes(token)) score += 2;
    if (description.includes(token)) score += 1;
  }
  return score;
}

export interface SearchOptions {
  query?: string;
  tag?: string;
  limit: number;
}

export function searchOperations(ops: ToolOperation[], opts: SearchOptions): SearchHit[] {
  let pool = ops;
  if (opts.tag) {
    const tag = opts.tag.toLowerCase();
    pool = pool.filter((op) => op.tags.some((t) => t.toLowerCase() === tag));
  }

  const query = (opts.query ?? "").trim();
  if (!query) {
    // No query: return a stable slice of the (optionally tag-filtered) pool.
    return pool.slice(0, opts.limit).map((op) => ({ op, score: 0 }));
  }

  const queryTokens = tokenize(query);
  const queryLower = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const op of pool) {
    const score = scoreOperation(op, queryTokens, queryLower);
    if (score > 0) hits.push({ op, score });
  }
  hits.sort((a, b) => b.score - a.score || a.op.name.localeCompare(b.op.name));
  return hits.slice(0, opts.limit);
}
