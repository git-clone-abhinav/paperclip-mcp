/** Configuration resolved from environment variables and CLI flags. */
import { getPackageVersion } from "./paths.js";

export type SpecSource = "auto" | "live" | "bundled";
export type TransportKind = "stdio" | "http";

/**
 * Tool-exposure mode.
 * - gateway: expose ONLY the meta-tools (search/inspect/call). Progressive tool discovery —
 *   the model never sees all ~400 schemas at once. This is the production-grade default.
 * - direct: expose every (filtered) endpoint as its own tool, plus the meta-tools.
 * - hybrid: expose only the allowlisted endpoints (via include filters) as tools, plus meta-tools.
 */
export type ToolMode = "gateway" | "direct" | "hybrid";

export interface PaperclipMcpConfig {
  /** Instance origin. The operation path (which already starts with /api) is resolved against this. */
  baseUrl: string;
  apiKey?: string;
  runId?: string;
  /** Where to fetch the live OpenAPI document. Defaults to <baseUrl>/api/openapi.json. */
  openapiUrl: string;
  specSource: SpecSource;
  mode: ToolMode;
  includeTags?: string[];
  excludeTags?: string[];
  includeRegex?: RegExp;
  excludeRegex?: RegExp;
  transport: TransportKind;
  httpHost: string;
  httpPort: number;
  requestTimeoutMs: number;
  /** Require an explicit confirm:true before executing destructive (DELETE) operations. */
  confirmDestructive: boolean;
  /** Truncate tool result text beyond this many characters (0 = unlimited). */
  maxResultChars: number;
  /** Default number of results returned by paperclip_search_tools. */
  searchLimit: number;
  /** Expose the raw paperclip_request escape hatch (bypasses registry risk gating). */
  enableRawRequestTool: boolean;
  extraHeaders: Record<string, string>;
  serverName: string;
  serverVersion: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function toRegex(value: string | undefined): RegExp | undefined {
  if (!value) return undefined;
  return new RegExp(value);
}

function parseExtraHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizeMode(value: string | undefined): ToolMode {
  if (value === "direct" || value === "hybrid" || value === "gateway") return value;
  return "gateway";
}

interface CliFlags {
  transport?: TransportKind;
  port?: number;
  host?: string;
  baseUrl?: string;
  apiKey?: string;
  runId?: string;
  tags?: string[];
  excludeTags?: string[];
  specSource?: SpecSource;
  mode?: ToolMode;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case "--http":
        flags.transport = "http";
        break;
      case "--stdio":
        flags.transport = "stdio";
        break;
      case "--port":
        flags.port = Number.parseInt(next() ?? "", 10) || undefined;
        break;
      case "--host":
        flags.host = next();
        break;
      case "--base-url":
        flags.baseUrl = next();
        break;
      case "--api-key":
        flags.apiKey = next();
        break;
      case "--run-id":
        flags.runId = next();
        break;
      case "--tags":
        flags.tags = csv(next());
        break;
      case "--exclude-tags":
        flags.excludeTags = csv(next());
        break;
      case "--spec":
        flags.specSource = next() as SpecSource;
        break;
      case "--mode":
        flags.mode = normalizeMode(next());
        break;
      case "--direct":
        flags.mode = "direct";
        break;
      default:
        break;
    }
  }
  return flags;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): PaperclipMcpConfig {
  const flags = parseFlags(argv);

  const baseUrl = stripTrailingSlash(
    flags.baseUrl ?? env("PAPERCLIP_API_BASE_URL") ?? "http://localhost:3100",
  );
  const openapiUrl =
    env("PAPERCLIP_OPENAPI_URL") ?? new URL("/api/openapi.json", baseUrl).toString();

  const specSource = (flags.specSource ?? env("PAPERCLIP_OPENAPI_SOURCE") ?? "auto") as SpecSource;
  const transport = (flags.transport ?? env("PAPERCLIP_MCP_TRANSPORT") ?? "stdio") as TransportKind;

  return {
    baseUrl,
    apiKey: flags.apiKey ?? env("PAPERCLIP_API_KEY"),
    runId: flags.runId ?? env("PAPERCLIP_RUN_ID"),
    openapiUrl,
    specSource: ["auto", "live", "bundled"].includes(specSource) ? specSource : "auto",
    mode: flags.mode ?? normalizeMode(env("PAPERCLIP_MCP_MODE")),
    includeTags: flags.tags ?? csv(env("PAPERCLIP_MCP_TAGS")),
    excludeTags: flags.excludeTags ?? csv(env("PAPERCLIP_MCP_EXCLUDE_TAGS")),
    includeRegex: toRegex(env("PAPERCLIP_MCP_INCLUDE")),
    excludeRegex: toRegex(env("PAPERCLIP_MCP_EXCLUDE")),
    transport: transport === "http" ? "http" : "stdio",
    httpHost: flags.host ?? env("PAPERCLIP_MCP_HTTP_HOST") ?? "127.0.0.1",
    httpPort: flags.port ?? envInt("PAPERCLIP_MCP_HTTP_PORT", 3333),
    requestTimeoutMs: envInt("PAPERCLIP_HTTP_TIMEOUT_MS", 30_000),
    confirmDestructive: envBool("PAPERCLIP_MCP_CONFIRM_DESTRUCTIVE", true),
    maxResultChars: envInt("PAPERCLIP_MCP_MAX_RESULT_CHARS", 50_000),
    searchLimit: envInt("PAPERCLIP_MCP_SEARCH_LIMIT", 10),
    enableRawRequestTool: envBool("PAPERCLIP_MCP_RAW_REQUEST_TOOL", true),
    extraHeaders: parseExtraHeaders(env("PAPERCLIP_EXTRA_HEADERS")),
    serverName: env("PAPERCLIP_MCP_SERVER_NAME") ?? "paperclip",
    serverVersion: getPackageVersion(),
  };
}

/** Redacted view for logging — never print the API key. */
export function describeConfig(cfg: PaperclipMcpConfig): Record<string, unknown> {
  return {
    baseUrl: cfg.baseUrl,
    openapiUrl: cfg.openapiUrl,
    specSource: cfg.specSource,
    mode: cfg.mode,
    transport: cfg.transport,
    apiKey: cfg.apiKey ? "set" : "unset",
    runId: cfg.runId ?? null,
    includeTags: cfg.includeTags ?? null,
    excludeTags: cfg.excludeTags ?? null,
    confirmDestructive: cfg.confirmDestructive,
    maxResultChars: cfg.maxResultChars,
    enableRawRequestTool: cfg.enableRawRequestTool,
  };
}
