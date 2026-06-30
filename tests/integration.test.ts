import { createServer, type Server as HttpServer } from "node:http";
import { resolve } from "node:path";
import { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { packageRoot } from "../src/paths.js";

interface MockCall {
  method: string;
  url: string;
  authorization: string | undefined;
  runId: string | undefined;
  body: string;
}

let httpServer: HttpServer;
let mockBaseUrl: string;
const calls: MockCall[] = [];

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      calls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers["authorization"],
        runId: req.headers["x-paperclip-run-id"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const { port } = httpServer.address() as AddressInfo;
  mockBaseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
});

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function firstText(res: ToolCallResult): string {
  return res.content.find((c) => c.type === "text")?.text ?? "";
}

async function withClient(
  envOverrides: Record<string, string>,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve(packageRoot, "src/index.ts")],
    cwd: packageRoot,
    env: {
      ...(process.env as Record<string, string>),
      PAPERCLIP_OPENAPI_SOURCE: "bundled",
      PAPERCLIP_API_BASE_URL: mockBaseUrl,
      PAPERCLIP_API_KEY: "pcp_board_testtoken",
      PAPERCLIP_MCP_LOG_LEVEL: "silent",
      ...envOverrides,
    },
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

describe("gateway mode (default)", () => {
  it(
    "exposes only meta-tools, not the full endpoint surface",
    async () => {
      await withClient({}, async (client) => {
        const { tools } = await client.listTools();
        const names = new Set(tools.map((t) => t.name));
        expect(names.has("paperclip_search_tools")).toBe(true);
        expect(names.has("paperclip_inspect_tool")).toBe(true);
        expect(names.has("paperclip_call_tool")).toBe(true);
        // endpoint tools are NOT dumped into context in gateway mode
        expect(names.has("get_companies_companyId")).toBe(false);
        expect(tools.length).toBeLessThan(10);
      });
    },
    30_000,
  );

  it(
    "search returns ranked tools plus the full tag directory",
    async () => {
      await withClient({}, async (client) => {
        const res = (await client.callTool({
          name: "paperclip_search_tools",
          arguments: { query: "create issue", limit: 5 },
        })) as ToolCallResult;
        const payload = JSON.parse(firstText(res)) as {
          availableTags: Array<{ tag: string; count: number }>;
          results: Array<{ tool: string; method: string; path: string; risk: string }>;
        };
        expect(payload.availableTags.length).toBeGreaterThan(20);
        expect(payload.availableTags.some((t) => t.tag === "issues")).toBe(true);
        expect(payload.results.length).toBeGreaterThan(0);
      });
    },
    30_000,
  );

  it(
    "inspect → call routes path params and forwards auth",
    async () => {
      await withClient({}, async (client) => {
        const inspect = (await client.callTool({
          name: "paperclip_inspect_tool",
          arguments: { name: "get_companies_companyId" },
        })) as ToolCallResult;
        const meta = JSON.parse(firstText(inspect)) as { method: string; risk: string };
        expect(meta.method).toBe("GET");
        expect(meta.risk).toBe("read");

        const before = calls.length;
        const res = (await client.callTool({
          name: "paperclip_call_tool",
          arguments: { name: "get_companies_companyId", arguments: { companyId: "company-1" } },
        })) as ToolCallResult;
        expect(res.isError).not.toBe(true);
        const newCalls = calls.slice(before);
        expect(newCalls.length).toBe(1);
        expect(newCalls[0]?.method).toBe("GET");
        expect(newCalls[0]?.url).toBe("/api/companies/company-1");
        expect(newCalls[0]?.authorization).toBe("Bearer pcp_board_testtoken");
      });
    },
    30_000,
  );

  it(
    "blocks destructive calls without confirm:true",
    async () => {
      await withClient({}, async (client) => {
        // find a DELETE tool from the spec via search
        const search = (await client.callTool({
          name: "paperclip_search_tools",
          arguments: { tag: "agents", limit: 100 },
        })) as ToolCallResult;
        const results = (JSON.parse(firstText(search)) as {
          results: Array<{ tool: string; method: string; risk: string }>;
        }).results;
        const del = results.find((r) => r.method === "DELETE");
        expect(del).toBeTruthy();

        const before = calls.length;
        const res = (await client.callTool({
          name: "paperclip_call_tool",
          arguments: { name: del!.tool, arguments: {} },
        })) as ToolCallResult;
        expect(firstText(res)).toMatch(/destructive/i);
        // no HTTP call should have been made
        expect(calls.length).toBe(before);
      });
    },
    30_000,
  );
});

describe("direct mode", () => {
  it(
    "exposes the full endpoint surface as individual tools",
    async () => {
      await withClient({ PAPERCLIP_MCP_MODE: "direct" }, async (client) => {
        const { tools } = await client.listTools();
        const names = new Set(tools.map((t) => t.name));
        expect(tools.length).toBeGreaterThan(400);
        expect(names.has("get_companies_companyId")).toBe(true);
        expect(names.has("paperclip_search_tools")).toBe(true);
      });
    },
    30_000,
  );

  it(
    "raw request tool reaches arbitrary paths with a JSON body + run id",
    async () => {
      await withClient({ PAPERCLIP_MCP_MODE: "direct" }, async (client) => {
        const before = calls.length;
        await client.callTool({
          name: "paperclip_request",
          arguments: {
            method: "POST",
            path: "/api/companies/company-1/issues",
            body: { title: "from raw tool" },
            runId: "run_42",
          },
        });
        const newCalls = calls.slice(before);
        expect(newCalls.length).toBe(1);
        expect(newCalls[0]?.method).toBe("POST");
        expect(newCalls[0]?.runId).toBe("run_42");
        expect(JSON.parse(newCalls[0]?.body ?? "{}")).toEqual({ title: "from raw tool" });
      });
    },
    30_000,
  );
});
