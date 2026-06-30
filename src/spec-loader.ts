/** Loads the OpenAPI document: from a live instance, the bundled snapshot, or both (auto). */
import { readFileSync } from "node:fs";

import type { PaperclipMcpConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { bundledSpecPath, bundledEnrichmentPath } from "./paths.js";
import type { OpenApiDocument } from "./openapi-types.js";

export type SpecOrigin = "live" | "bundled";

export interface LoadedSpec {
  spec: OpenApiDocument;
  origin: SpecOrigin;
}

function readBundledSpec(): OpenApiDocument {
  const raw = readFileSync(bundledSpecPath, "utf8");
  return JSON.parse(raw) as OpenApiDocument;
}

async function fetchLiveSpec(cfg: PaperclipMcpConfig): Promise<OpenApiDocument> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  try {
    const headers: Record<string, string> = { Accept: "application/json", ...cfg.extraHeaders };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
    const res = await fetch(cfg.openapiUrl, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${cfg.openapiUrl}`);
    const doc = (await res.json()) as OpenApiDocument;
    if (!doc?.paths || typeof doc.paths !== "object") {
      throw new Error(`Response from ${cfg.openapiUrl} is not an OpenAPI document`);
    }
    return doc;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadSpec(cfg: PaperclipMcpConfig, log: Logger): Promise<LoadedSpec> {
  if (cfg.specSource === "bundled") {
    log.info(`Loading bundled OpenAPI snapshot from ${bundledSpecPath}`);
    return { spec: readBundledSpec(), origin: "bundled" };
  }

  try {
    log.info(`Fetching live OpenAPI document from ${cfg.openapiUrl}`);
    const spec = await fetchLiveSpec(cfg);
    return { spec, origin: "live" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cfg.specSource === "live") {
      throw new Error(`Failed to fetch live OpenAPI document (spec source is "live"): ${message}`);
    }
    log.warn(`Live OpenAPI fetch failed (${message}); falling back to bundled snapshot`);
    return { spec: readBundledSpec(), origin: "bundled" };
  }
}

export type EnrichmentMap = Record<string, { description: string; usage?: string }>;

/** Loads the optional per-endpoint enrichment map produced by the doc-enrichment workflow. */
export function loadEnrichment(log: Logger): EnrichmentMap {
  try {
    const raw = readFileSync(bundledEnrichmentPath, "utf8");
    const parsed = JSON.parse(raw) as EnrichmentMap;
    log.debug(`Loaded ${Object.keys(parsed).length} enrichment entries`);
    return parsed;
  } catch {
    return {};
  }
}
