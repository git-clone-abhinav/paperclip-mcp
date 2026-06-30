/** Thin HTTP client for the Paperclip REST API. */
import type { PaperclipMcpConfig } from "./config.js";
import type { Logger } from "./logger.js";

export interface ApiRequestOptions {
  method: string;
  /** Absolute path beginning with "/" (already substituted, e.g. /api/companies/abc/issues). */
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  runId?: string;
  headers?: Record<string, string>;
}

export interface ApiResult {
  status: number;
  ok: boolean;
  data: unknown;
  contentType: string | null;
  url: string;
}

export class PaperclipClient {
  constructor(
    private readonly cfg: PaperclipMcpConfig,
    private readonly log: Logger,
  ) {}

  private buildUrl(path: string, query?: Record<string, unknown>): URL {
    // path is absolute ("/api/..."), so only the origin of baseUrl is used.
    const url = new URL(path, this.cfg.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item));
        } else if (typeof value === "object") {
          url.searchParams.append(key, JSON.stringify(value));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url;
  }

  async request(opts: ApiRequestOptions): Promise<ApiResult> {
    const url = this.buildUrl(opts.path, opts.query);
    const method = opts.method.toUpperCase();

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.cfg.extraHeaders,
      ...(opts.headers ?? {}),
    };
    if (this.cfg.apiKey) headers["Authorization"] = `Bearer ${this.cfg.apiKey}`;
    const runId = opts.runId ?? this.cfg.runId;
    if (runId) headers["X-Paperclip-Run-Id"] = runId;

    let bodyInit: string | undefined;
    if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(opts.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      this.log.debug(`${method} ${url.pathname}${url.search}`);
      const res = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller.signal,
      });
      const contentType = res.headers.get("content-type");
      const text = await res.text();
      let data: unknown = text === "" ? null : text;
      if (contentType?.includes("application/json") && text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { status: res.status, ok: res.ok, data, contentType, url: url.toString() };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      const message = aborted
        ? `Request timed out after ${this.cfg.requestTimeoutMs}ms`
        : `Request failed: ${err instanceof Error ? err.message : String(err)}`;
      this.log.warn(message);
      return {
        status: 0,
        ok: false,
        data: { error: message },
        contentType: null,
        url: url.toString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
