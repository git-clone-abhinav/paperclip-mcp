/**
 * Assembles the MCP server.
 *
 * The default "gateway" mode exposes only meta-tools (search / inspect / call) so the model
 * practices progressive tool discovery instead of loading ~400 endpoint schemas at once.
 * "direct"/"hybrid" modes additionally register endpoint tools (filtered) for clients that
 * prefer the full surface.
 */
// We use the low-level `Server` deliberately (the SDK marks it "for advanced use cases"):
// tools are generated dynamically from the OpenAPI spec with raw JSON Schema input schemas,
// which the high-level McpServer.registerTool (Zod/StandardSchema shapes) is not built for.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { PaperclipMcpConfig } from "./config.js";
import type { ApiResult, PaperclipClient } from "./http-client.js";
import type { Logger } from "./logger.js";
import type { EnrichmentMap } from "./spec-loader.js";
import type { OpenApiDocument } from "./openapi-types.js";
import { collectTags, searchOperations, tagList } from "./registry.js";
import {
  buildOperations,
  filterOperations,
  splitArgs,
  substitutePath,
  type ToolOperation,
} from "./tools.js";

export const SEARCH_TOOLS_TOOL = "paperclip_search_tools";
export const INSPECT_TOOL_TOOL = "paperclip_inspect_tool";
export const CALL_TOOL_TOOL = "paperclip_call_tool";
export const RAW_REQUEST_TOOL = "paperclip_request";

export interface McpDeps {
  config: PaperclipMcpConfig;
  client: PaperclipClient;
  spec: OpenApiDocument;
  enrichment: EnrichmentMap;
  log: Logger;
}

export interface McpStats {
  mode: PaperclipMcpConfig["mode"];
  totalOperations: number;
  exposedEndpointTools: number;
  totalTools: number;
  tags: number;
}

export interface PaperclipMcp {
  buildServer(): Server;
  stats: McpStats;
  tools: Tool[];
  allOperations: ToolOperation[];
  exposedOperations: ToolOperation[];
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function operationSummaryRow(op: ToolOperation): Record<string, unknown> {
  return {
    tool: op.name,
    method: op.method.toUpperCase(),
    path: op.path,
    risk: op.risk,
    elevated: op.elevated,
    tags: op.tags,
    summary: op.summary,
  };
}

export function createPaperclipMcp(deps: McpDeps): PaperclipMcp {
  const { config, client, spec, enrichment, log } = deps;

  const allOperations = buildOperations(spec, enrichment);
  const allByName = new Map(allOperations.map((op) => [op.name, op]));
  const tags = tagList(allOperations);
  const tagCounts = collectTags(allOperations);

  // Endpoint-tool exposure depends on the mode.
  let exposedOperations: ToolOperation[] = [];
  if (config.mode === "direct") {
    exposedOperations = filterOperations(allOperations, config);
  } else if (config.mode === "hybrid") {
    const hasAllowlist = Boolean(
      config.includeTags?.length || config.includeRegex,
    );
    if (hasAllowlist) {
      exposedOperations = filterOperations(allOperations, config);
    } else {
      log.warn(
        "hybrid mode without an allowlist (PAPERCLIP_MCP_TAGS / PAPERCLIP_MCP_INCLUDE) exposes no endpoint tools; use gateway meta-tools instead.",
      );
    }
  }
  const exposedByName = new Map(exposedOperations.map((op) => [op.name, op]));

  function truncate(text: string): string {
    const max = config.maxResultChars;
    if (max > 0 && text.length > max) {
      return `${text.slice(0, max)}\n\n…[truncated ${text.length - max} chars; refine the request or raise PAPERCLIP_MCP_MAX_RESULT_CHARS]`;
    }
    return text;
  }

  function apiResultToTool(result: ApiResult): CallToolResult {
    const body =
      typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
    const status = result.status === 0 ? "NETWORK ERROR" : `HTTP ${result.status}`;
    const verdict = result.ok ? "OK" : "ERROR";
    return textResult(truncate(`${status} ${verdict} — ${result.url}\n\n${body}`), !result.ok);
  }

  async function runOperation(
    op: ToolOperation,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { pathValues, query, body } = splitArgs(op.mapping, args);
    let path: string;
    try {
      path = substitutePath(op.path, pathValues);
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
    const runId = typeof args["runId"] === "string" ? (args["runId"] as string) : undefined;
    const result = await client.request({ method: op.method, path, query, body, runId });
    return apiResultToTool(result);
  }

  // ── Meta-tool definitions ────────────────────────────────────────────────
  function metaToolDefs(): Tool[] {
    const tools: Tool[] = [
      {
        name: SEARCH_TOOLS_TOOL,
        description:
          `Search the Paperclip API tool registry (${allOperations.length} endpoints across ${tags.length} namespaces). ` +
          "Returns the most relevant endpoints for a query plus the full list of available tags. " +
          "Use this FIRST to discover which endpoint to call, then paperclip_inspect_tool for its schema, " +
          "then paperclip_call_tool to run it. Call with no query to browse a namespace (tag).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keywords describing the task (e.g. 'create issue', 'rotate secret').",
            },
            tag: {
              type: "string",
              description: "Restrict to one namespace/tag.",
              enum: tags,
            },
            limit: {
              type: "integer",
              description: `Max results (default ${config.searchLimit}).`,
              minimum: 1,
            },
          },
        },
      },
      {
        name: INSPECT_TOOL_TOOL,
        description:
          "Get the full description, input schema, risk level, and auth actor for one endpoint tool " +
          "(by the name returned from paperclip_search_tools). Read this before calling an unfamiliar tool.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tool name (e.g. post_companies_companyId_issues)" },
          },
          required: ["name"],
        },
      },
      {
        name: CALL_TOOL_TOOL,
        description:
          "Execute an endpoint tool by name with its arguments. Arguments follow the schema from " +
          "paperclip_inspect_tool (path params, query params, and body fields merged into one object). " +
          "Destructive (DELETE) operations require confirm:true.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tool name to execute" },
            arguments: {
              type: "object",
              description: "Arguments matching the tool's input schema",
              additionalProperties: true,
            },
            confirm: {
              type: "boolean",
              description: "Required (true) to run destructive operations",
            },
          },
          required: ["name"],
        },
      },
    ];

    if (config.enableRawRequestTool) {
      tools.push({
        name: RAW_REQUEST_TOOL,
        description:
          "Escape hatch: call any Paperclip REST endpoint by raw method + path (path params already " +
          "substituted, e.g. /api/companies/<id>/issues). Bypasses the registry; auth + base URL are applied.",
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
              description: "HTTP method",
            },
            path: {
              type: "string",
              description: "Absolute API path beginning with /api (path params already substituted)",
            },
            query: {
              type: "object",
              description: "Optional query-string parameters",
              additionalProperties: true,
            },
            body: { description: "Optional JSON request body" },
            runId: { type: "string", description: "Optional X-Paperclip-Run-Id header value" },
          },
          required: ["method", "path"],
        },
      });
    }

    return tools;
  }

  const endpointTools: Tool[] = exposedOperations.map((op) => ({
    name: op.name,
    description: op.description,
    inputSchema: op.inputSchema as Tool["inputSchema"],
  }));
  const tools: Tool[] = [...endpointTools, ...metaToolDefs()];

  // ── Meta-tool handlers ───────────────────────────────────────────────────
  function handleSearch(args: Record<string, unknown>): CallToolResult {
    const query = typeof args["query"] === "string" ? args["query"] : undefined;
    const tag = typeof args["tag"] === "string" ? args["tag"] : undefined;
    const limit = typeof args["limit"] === "number" ? args["limit"] : config.searchLimit;
    const hits = searchOperations(allOperations, { query, tag, limit });
    return textResult(
      JSON.stringify(
        {
          query: query ?? null,
          tag: tag ?? null,
          availableTags: tagCounts,
          totalMatches: hits.length,
          results: hits.map((h) => operationSummaryRow(h.op)),
        },
        null,
        2,
      ),
    );
  }

  function handleInspect(args: Record<string, unknown>): CallToolResult {
    const name = typeof args["name"] === "string" ? args["name"] : undefined;
    if (!name) return textResult("paperclip_inspect_tool requires 'name'.", true);
    const op = allByName.get(name);
    if (!op) {
      return textResult(
        `Unknown tool "${name}". Use paperclip_search_tools to find valid tool names.`,
        true,
      );
    }
    return textResult(
      JSON.stringify(
        {
          tool: op.name,
          method: op.method.toUpperCase(),
          path: op.path,
          tags: op.tags,
          risk: op.risk,
          elevated: op.elevated,
          authActor: op.actor,
          summary: op.summary,
          description: op.description,
          inputSchema: op.inputSchema,
        },
        null,
        2,
      ),
    );
  }

  async function handleCall(args: Record<string, unknown>): Promise<CallToolResult> {
    const name = typeof args["name"] === "string" ? args["name"] : undefined;
    if (!name) return textResult("paperclip_call_tool requires 'name'.", true);
    const op = allByName.get(name);
    if (!op) {
      return textResult(
        `Unknown tool "${name}". Use paperclip_search_tools to find valid tool names.`,
        true,
      );
    }
    const callArgs =
      args["arguments"] && typeof args["arguments"] === "object"
        ? (args["arguments"] as Record<string, unknown>)
        : {};
    if (op.risk === "destructive" && config.confirmDestructive && args["confirm"] !== true) {
      return textResult(
        `"${op.name}" is a destructive operation (${op.method.toUpperCase()} ${op.path}). ` +
          "Re-call paperclip_call_tool with confirm:true to proceed.",
      );
    }
    return runOperation(op, callArgs);
  }

  async function handleRawRequest(args: Record<string, unknown>): Promise<CallToolResult> {
    const method = typeof args["method"] === "string" ? args["method"] : undefined;
    const path = typeof args["path"] === "string" ? args["path"] : undefined;
    if (!method || !path) return textResult("paperclip_request requires 'method' and 'path'.", true);
    if (!path.startsWith("/")) {
      return textResult("'path' must be an absolute path beginning with '/'.", true);
    }
    const query =
      args["query"] && typeof args["query"] === "object"
        ? (args["query"] as Record<string, unknown>)
        : undefined;
    const runId = typeof args["runId"] === "string" ? (args["runId"] as string) : undefined;
    const result = await client.request({ method, path, query, body: args["body"], runId });
    return apiResultToTool(result);
  }

  async function dispatch(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    switch (name) {
      case SEARCH_TOOLS_TOOL:
        return handleSearch(args);
      case INSPECT_TOOL_TOOL:
        return handleInspect(args);
      case CALL_TOOL_TOOL:
        return handleCall(args);
      case RAW_REQUEST_TOOL:
        if (config.enableRawRequestTool) return handleRawRequest(args);
        break;
      default:
        break;
    }
    const op = exposedByName.get(name);
    if (op) return runOperation(op, args);
    return textResult(`Unknown tool: ${name}`, true);
  }

  function buildServer(): Server {
    const server = new Server(
      { name: config.serverName, version: config.serverVersion },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      try {
        return await dispatch(name, args);
      } catch (err) {
        log.error(`Tool ${name} failed`, err);
        return textResult(
          `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    });

    return server;
  }

  return {
    buildServer,
    stats: {
      mode: config.mode,
      totalOperations: allOperations.length,
      exposedEndpointTools: endpointTools.length,
      totalTools: tools.length,
      tags: tags.length,
    },
    tools,
    allOperations,
    exposedOperations,
  };
}
