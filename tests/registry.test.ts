import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bundledSpecPath } from "../src/paths.js";
import type { OpenApiDocument } from "../src/openapi-types.js";
import { buildOperations, methodRisk } from "../src/tools.js";
import { collectTags, searchOperations, tagList } from "../src/registry.js";

const spec = JSON.parse(readFileSync(bundledSpecPath, "utf8")) as OpenApiDocument;
const ops = buildOperations(spec);

describe("methodRisk", () => {
  it("classifies HTTP methods by risk", () => {
    expect(methodRisk("get")).toBe("read");
    expect(methodRisk("post")).toBe("write");
    expect(methodRisk("patch")).toBe("write");
    expect(methodRisk("delete")).toBe("destructive");
  });
});

describe("tags", () => {
  it("collects every tag in the spec with counts", () => {
    const tags = collectTags(ops);
    expect(tags.length).toBeGreaterThan(20);
    expect(tags.every((t) => t.count > 0)).toBe(true);
    // sorted alphabetically and deduplicated
    const names = tags.map((t) => t.tag);
    expect([...names].sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
    expect(tagList(ops)).toContain("issues");
  });
});

describe("searchOperations", () => {
  it("ranks relevant endpoints first for a keyword query", () => {
    const hits = searchOperations(ops, { query: "create issue", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    // a POST .../issues should surface near the top
    const top = hits.slice(0, 5).map((h) => h.op);
    expect(top.some((op) => op.method === "post" && /\/issues$/.test(op.path))).toBe(true);
  });

  it("filters by tag namespace", () => {
    const hits = searchOperations(ops, { tag: "secrets", limit: 100 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.op.tags.includes("secrets"))).toBe(true);
  });

  it("returns a browse slice when no query is given", () => {
    const hits = searchOperations(ops, { tag: "agents", limit: 3 });
    expect(hits.length).toBe(3);
  });

  it("respects the limit", () => {
    const hits = searchOperations(ops, { query: "agent", limit: 4 });
    expect(hits.length).toBeLessThanOrEqual(4);
  });
});
