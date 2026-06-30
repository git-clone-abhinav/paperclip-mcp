/**
 * Tiny stderr logger.
 *
 * IMPORTANT: never write logs to stdout — when running over the stdio transport,
 * stdout carries the MCP JSON-RPC protocol and any stray bytes corrupt it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function format(level: LogLevel, name: string, args: unknown[]): string {
  const parts = args.map((a) =>
    typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a),
  );
  return `[${name}] ${level.toUpperCase()} ${parts.join(" ")}\n`;
}

export function createLogger(name = "paperclip-mcp"): Logger {
  const configured = (process.env.PAPERCLIP_MCP_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  const threshold = LEVELS[configured] ?? LEVELS.info;

  function write(level: LogLevel, args: unknown[]): void {
    if (LEVELS[level] < threshold) return;
    process.stderr.write(format(level, name, args));
  }

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}
