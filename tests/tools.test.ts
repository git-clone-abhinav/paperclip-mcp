import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bundledSpecPath } from "../src/paths.js";
import type { OpenApiDocument } from "../src/openapi-types.js";
import {
  buildOperations,
  deriveToolName,
  filterOperations,
  splitArgs,
  substitutePath,
} from "../src/tools.js";
import type { PaperclipMcpConfig } from "../src/config.js";

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function baseConfig(overrides: Partial<PaperclipMcpConfig> = {}): PaperclipMcpConfig {
  return {
    baseUrl: "http://localhost:3100",
    openapiUrl: "http://localhost:3100/api/openapi.json",
    specSource: "bundled",
    mode: "direct",
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 3333,
    requestTimeoutMs: 30_000,
    confirmDestructive: true,
    maxResultChars: 50_000,
    searchLimit: 10,
    enableRawRequestTool: true,
    extraHeaders: {},
    serverName: "paperclip",
    serverVersion: "0.0.0",
    ...overrides,
  };
}

// A small synthetic spec exercising path params, query params, flatten + wrapped bodies.
const fixture: OpenApiDocument = {
  openapi: "3.0.0",
  info: { title: "Fixture", version: "1.0.0" },
  paths: {
    "/api/companies/{companyId}/issues": {
      get: {
        tags: ["issues"],
        summary: "List issues",
        parameters: [
          { name: "companyId", in: "path", required: true, schema: { type: "string" } },
          { name: "status", in: "query", required: false, schema: { type: "string" } },
        ],
      },
      post: {
        tags: ["issues"],
        summary: "Create issue",
        parameters: [{ name: "companyId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { title: { type: "string" }, body: { type: "string" } },
                required: ["title"],
              },
            },
          },
        },
      },
    },
    "/api/raw": {
      post: {
        tags: ["misc"],
        summary: "Wrapped body",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "array", items: { type: "string" } } } },
        },
      },
    },
  },
};

describe("deriveToolName", () => {
  it("derives readable names and strips the /api prefix", () => {
    const used = new Set<string>();
    expect(deriveToolName("get", "/api/companies/{companyId}/issues", used)).toBe(
      "get_companies_companyId_issues",
    );
  });

  it("always produces names matching the MCP tool-name pattern (<=64 chars)", () => {
    const used = new Set<string>();
    const long =
      "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}/validate";
    const name = deriveToolName("post", long, used);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(NAME_RE.test(name)).toBe(true);
  });

  it("disambiguates collisions", () => {
    const used = new Set<string>();
    const a = deriveToolName("get", "/api/x", used);
    const b = deriveToolName("get", "/api/x", used); // forced collision
    expect(a).not.toBe(b);
    expect(used.size).toBe(2);
  });
});

describe("buildOperations + splitArgs", () => {
  const ops = buildOperations(fixture);
  const byName = new Map(ops.map((o) => [o.name, o]));

  it("creates one operation per method", () => {
    expect(ops).toHaveLength(3);
  });

  it("marks path params required and routes them to the URL", () => {
    const op = byName.get("get_companies_companyId_issues");
    expect(op).toBeTruthy();
    expect(op?.inputSchema.required).toContain("companyId");
    const { pathValues, query } = splitArgs(op!.mapping, { companyId: "c1", status: "open" });
    expect(pathValues).toEqual({ companyId: "c1" });
    expect(query).toEqual({ status: "open" });
  });

  it("flattens an object body and routes non-path/query args into it", () => {
    const op = byName.get("post_companies_companyId_issues");
    expect(op?.inputSchema.properties).toHaveProperty("title");
    expect(op?.inputSchema.required).toEqual(expect.arrayContaining(["companyId", "title"]));
    const { pathValues, body } = splitArgs(op!.mapping, {
      companyId: "c1",
      title: "Bug",
      body: "details",
    });
    expect(pathValues).toEqual({ companyId: "c1" });
    expect(body).toEqual({ title: "Bug", body: "details" });
  });

  it("wraps a non-object body under 'body'", () => {
    const op = byName.get("post_raw");
    expect(op?.mapping.bodyMode).toBe("wrapped");
    expect(op?.inputSchema.required).toContain("body");
    const { body } = splitArgs(op!.mapping, { body: ["a", "b"] });
    expect(body).toEqual(["a", "b"]);
  });
});

describe("substitutePath", () => {
  it("substitutes and URL-encodes params", () => {
    expect(substitutePath("/api/companies/{companyId}/issues", { companyId: "a b/c" })).toBe(
      "/api/companies/a%20b%2Fc/issues",
    );
  });

  it("throws when a required path param is missing", () => {
    expect(() => substitutePath("/api/companies/{companyId}", {})).toThrow(/companyId/);
  });
});

describe("filterOperations", () => {
  const ops = buildOperations(fixture);

  it("includes only matching tags", () => {
    const filtered = filterOperations(ops, baseConfig({ includeTags: ["issues"] }));
    expect(filtered.every((o) => o.tags.includes("issues"))).toBe(true);
    expect(filtered).toHaveLength(2);
  });

  it("excludes matching tags", () => {
    const filtered = filterOperations(ops, baseConfig({ excludeTags: ["misc"] }));
    expect(filtered.some((o) => o.tags.includes("misc"))).toBe(false);
  });

  it("applies include/exclude regexes against name and path", () => {
    const filtered = filterOperations(ops, baseConfig({ includeRegex: /\/raw$/ }));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.path).toBe("/api/raw");
  });
});

describe("bundled spec", () => {
  const spec = JSON.parse(readFileSync(bundledSpecPath, "utf8")) as OpenApiDocument;
  const ops = buildOperations(spec);

  it("produces a tool for every operation with unique, valid names", () => {
    const names = new Set(ops.map((o) => o.name));
    expect(names.size).toBe(ops.length);
    expect(ops.length).toBeGreaterThan(400);
    for (const op of ops) expect(NAME_RE.test(op.name)).toBe(true);
  });
});
