/**
 * Turns an OpenAPI document into MCP tool definitions — one tool per operation.
 *
 * The Paperclip spec has no operationIds, so tool names are derived deterministically
 * from method + path. Path params, query params, and the JSON request body are merged
 * into a single flat input schema; `splitArgs` routes a tool call's arguments back to
 * the right place (URL path, query string, body).
 */
import type { PaperclipMcpConfig } from "./config.js";
import type { EnrichmentMap } from "./spec-loader.js";
import {
  HTTP_METHODS,
  isHttpMethod,
  type HttpMethod,
  type JsonSchema,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiParameter,
} from "./openapi-types.js";

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
};

export type BodyMode = "none" | "flatten" | "wrapped";

export type RiskLevel = "read" | "write" | "destructive";

export interface ArgMapping {
  pathParams: string[];
  queryParams: string[];
  bodyMode: BodyMode;
}

export interface ToolOperation {
  name: string;
  method: HttpMethod;
  path: string;
  tags: string[];
  summary: string;
  description: string;
  actor: string | null;
  /** read (GET/HEAD), write (POST/PUT/PATCH), destructive (DELETE). */
  risk: RiskLevel;
  /** Requires instance-admin authorization. */
  elevated: boolean;
  inputSchema: ToolInputSchema;
  mapping: ArgMapping;
}

export function methodRisk(method: HttpMethod): RiskLevel {
  if (method === "delete") return "destructive";
  if (method === "post" || method === "put" || method === "patch") return "write";
  return "read";
}

const TOOL_NAME_MAX = 64;

function sanitizeSegment(path: string): string {
  return path
    .replace(/^\/api\//, "")
    .replace(/^\//, "")
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Deterministic 6-char hash for disambiguating long/duplicate tool names. */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(36).slice(0, 6).padStart(6, "0");
}

export function deriveToolName(method: string, path: string, used: Set<string>): string {
  const base = `${method.toLowerCase()}_${sanitizeSegment(path)}`;
  let name = base;
  if (name.length > TOOL_NAME_MAX) {
    const hash = shortHash(`${method} ${path}`);
    name = `${base.slice(0, TOOL_NAME_MAX - hash.length - 1)}_${hash}`;
  }
  if (used.has(name)) {
    const hash = shortHash(`${method} ${path}`);
    const stem = base.slice(0, Math.max(0, TOOL_NAME_MAX - hash.length - 1));
    name = `${stem}_${hash}`;
    let counter = 1;
    while (used.has(name)) {
      const suffix = `_${hash}${counter}`;
      name = `${base.slice(0, TOOL_NAME_MAX - suffix.length)}${suffix}`;
      counter++;
    }
  }
  used.add(name);
  return name;
}

function withDescription(schema: JsonSchema | undefined, description?: string): JsonSchema {
  const base: JsonSchema = schema ? { ...schema } : { type: "string" };
  if (description && !base.description) base.description = description;
  return base;
}

function jsonBodySchema(op: OpenApiOperation): JsonSchema | undefined {
  return op.requestBody?.content?.["application/json"]?.schema;
}

function buildInput(op: OpenApiOperation): { schema: ToolInputSchema; mapping: ArgMapping } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const pathParams: string[] = [];
  const queryParams: string[] = [];

  const params: OpenApiParameter[] = op.parameters ?? [];
  for (const p of params) {
    if (p.in === "path") {
      properties[p.name] = withDescription(p.schema, p.description);
      required.push(p.name);
      pathParams.push(p.name);
    } else if (p.in === "query") {
      properties[p.name] = withDescription(p.schema, p.description);
      if (p.required) required.push(p.name);
      queryParams.push(p.name);
    }
    // header/cookie params are auth/runtime concerns handled by the client, not tool inputs.
  }

  let bodyMode: BodyMode = "none";
  const bodySchema = jsonBodySchema(op);
  if (bodySchema) {
    const isObject = bodySchema.type === "object" && !!bodySchema.properties;
    let collision = false;
    if (isObject && bodySchema.properties) {
      for (const key of Object.keys(bodySchema.properties)) {
        if (key in properties) {
          collision = true;
          break;
        }
      }
    }

    if (isObject && !collision && bodySchema.properties) {
      bodyMode = "flatten";
      for (const [key, value] of Object.entries(bodySchema.properties)) {
        properties[key] = value;
      }
      if (op.requestBody?.required && Array.isArray(bodySchema.required)) {
        required.push(...bodySchema.required);
      }
    } else {
      bodyMode = "wrapped";
      properties["body"] = withDescription(bodySchema, "JSON request body");
      if (op.requestBody?.required) required.push("body");
    }
  }

  const schema: ToolInputSchema = { type: "object", properties };
  const uniqueRequired = [...new Set(required)];
  if (uniqueRequired.length) schema.required = uniqueRequired;
  return { schema, mapping: { pathParams, queryParams, bodyMode } };
}

function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function buildDescription(
  op: OpenApiOperation,
  method: HttpMethod,
  path: string,
  enrichment?: { description: string; usage?: string },
): string {
  const lines: string[] = [];
  lines.push(op.summary ?? `${method.toUpperCase()} ${path}`);
  lines.push("");
  lines.push(`${method.toUpperCase()} ${path}`);

  const actor = op["x-paperclip-authorization"]?.actor;
  if (actor) {
    const admin = op["x-paperclip-authorization"]?.instanceAdmin ? " · requires instance admin" : "";
    lines.push(`Auth actor: ${actor}${admin}`);
  }

  if (enrichment?.description) {
    lines.push("");
    lines.push(enrichment.description);
    if (enrichment.usage) lines.push(`Usage: ${enrichment.usage}`);
  } else if (op.description) {
    lines.push("");
    lines.push(op.description);
  }

  return lines.join("\n").trim();
}

export function buildOperations(
  spec: OpenApiDocument,
  enrichment: EnrichmentMap = {},
): ToolOperation[] {
  const used = new Set<string>();
  const operations: ToolOperation[] = [];
  const paths = spec.paths ?? {};

  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const { schema, mapping } = buildInput(op);
      const enrich = enrichment[operationKey(method, path)];
      operations.push({
        name: deriveToolName(method, path, used),
        method,
        path,
        tags: op.tags ?? [],
        summary: op.summary ?? `${method.toUpperCase()} ${path}`,
        description: buildDescription(op, method, path, enrich),
        actor: op["x-paperclip-authorization"]?.actor ?? null,
        risk: methodRisk(method),
        elevated: op["x-paperclip-authorization"]?.instanceAdmin === true,
        inputSchema: schema,
        mapping,
      });
    }
  }
  return operations;
}

export function filterOperations(
  operations: ToolOperation[],
  cfg: PaperclipMcpConfig,
): ToolOperation[] {
  return operations.filter((op) => {
    if (cfg.includeTags?.length && !op.tags.some((t) => cfg.includeTags?.includes(t))) return false;
    if (cfg.excludeTags?.length && op.tags.some((t) => cfg.excludeTags?.includes(t))) return false;
    if (cfg.includeRegex && !(cfg.includeRegex.test(op.name) || cfg.includeRegex.test(op.path))) {
      return false;
    }
    if (cfg.excludeRegex && (cfg.excludeRegex.test(op.name) || cfg.excludeRegex.test(op.path))) {
      return false;
    }
    return true;
  });
}

export interface SplitArgs {
  pathValues: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
}

export function splitArgs(mapping: ArgMapping, args: Record<string, unknown>): SplitArgs {
  const pathValues: Record<string, string> = {};
  const query: Record<string, unknown> = {};
  let body: unknown;

  for (const name of mapping.pathParams) {
    if (name in args && args[name] !== undefined) pathValues[name] = String(args[name]);
  }
  for (const name of mapping.queryParams) {
    if (name in args && args[name] !== undefined) query[name] = args[name];
  }

  if (mapping.bodyMode === "wrapped") {
    body = args["body"];
  } else if (mapping.bodyMode === "flatten") {
    const exclude = new Set<string>([...mapping.pathParams, ...mapping.queryParams]);
    const collected: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (key === "runId") continue;
      if (!exclude.has(key)) collected[key] = value;
    }
    body = Object.keys(collected).length ? collected : undefined;
  }

  return { pathValues, query, body };
}

/** Substitutes {param} placeholders in a path; throws if a required value is missing. */
export function substitutePath(path: string, pathValues: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathValues[name];
    if (value === undefined || value === "") {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(value);
  });
}

export { operationKey, isHttpMethod };
