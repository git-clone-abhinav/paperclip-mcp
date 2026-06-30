/**
 * Filesystem anchors for bundled assets.
 *
 * This module lives at <pkg>/src/paths.ts (dev, via tsx) and compiles to
 * <pkg>/dist/paths.js (build). In both cases the package root is one directory up,
 * so bundled assets under <pkg>/spec and <pkg>/package.json resolve identically.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(moduleDir, "..");

export const bundledSpecPath = resolve(packageRoot, "spec", "openapi.json");
export const bundledEnrichmentPath = resolve(packageRoot, "spec", "enrichment.json");

let cachedVersion: string | undefined;

export function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}
