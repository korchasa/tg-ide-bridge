/**
 * @module
 * Structured JSON logger + error sanitizer. Every log entry is a single
 * JSON object on stderr so operators can pipe into `jq`. `sanitizeError`
 * strips bot tokens from any string routed to logs or chat.
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogFields {
  [key: string]: unknown;
}

const TOKEN_IN_URL = /bot\d+:[A-Za-z0-9_-]+/g;

/**
 * Remove Telegram bot tokens from an arbitrary error/string value. Anything
 * matching `bot<digits>:<secret>` is replaced with `bot<REDACTED>`. Must be
 * called on every string that leaves the process toward chat or logs.
 */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error
    ? (err.stack ?? err.message)
    : typeof err === "string"
    ? err
    : JSON.stringify(err);
  return raw.replace(TOKEN_IN_URL, "bot<REDACTED>");
}

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
}

function emit(
  sink: (line: string) => void,
  level: LogLevel,
  msg: string,
  fields?: LogFields,
): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      record[k] = typeof v === "string" ? sanitizeError(v) : v;
    }
  }
  sink(JSON.stringify(record));
}

/** Create a logger that writes JSON lines to the given sink (default: stderr). */
export function createLogger(
  sink: (line: string) => void = (l) => console.error(l),
): Logger {
  return {
    info: (m, f) => emit(sink, "info", m, f),
    warn: (m, f) => emit(sink, "warn", m, f),
    error: (m, f) => emit(sink, "error", m, f),
    debug: (m, f) => emit(sink, "debug", m, f),
  };
}
