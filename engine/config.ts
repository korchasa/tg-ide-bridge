/**
 * @module
 * Deploy-time config: loaded from env vars only. Runtime-tunable IDE params
 * (model/effort/permission mode/timeout/retries) live in `SessionStore` and
 * are set via TG commands — not here.
 *
 * Contract: `loadConfig` either returns a fully validated `Config` or throws
 * `ConfigError` with a clear field-level message.
 */

export const SUPPORTED_IDES = [
  "claude",
  "opencode",
  "cursor",
  "codex",
] as const;
export type SupportedIde = typeof SUPPORTED_IDES[number];

export interface Config {
  token: string;
  allowed_chat_ids: number[];
  allowed_thread_ids?: number[];
  ide: SupportedIde;
  project_dir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  /** Working directory used as `project_dir`. Default: `Deno.cwd()`. */
  cwd?: string;
}

function requireNonEmpty(
  env: { get: (k: string) => string | undefined },
  key: string,
): string {
  const v = env.get(key);
  if (!v || v.trim() === "") {
    throw new ConfigError(`env var '${key}' is required and must be non-empty`);
  }
  return v.trim();
}

function parseIdList(raw: string, key: string): number[] {
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new ConfigError(`env var '${key}' must contain at least one id`);
  }
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new ConfigError(
        `env var '${key}' must be comma-separated integers; bad value: '${p}'`,
      );
    }
    out.push(n);
  }
  return out;
}

// FR-CONFIG
export function loadConfig(
  env: { get: (key: string) => string | undefined },
  opts: LoadConfigOptions = {},
): Config {
  const cwd = opts.cwd ?? Deno.cwd();

  const token = requireNonEmpty(env, "FLOWAI_TELEGRAM_BOT_TOKEN");

  const chatIdsRaw = requireNonEmpty(env, "FLOWAI_TELEGRAM_CHAT_ID");
  const allowed_chat_ids = parseIdList(
    chatIdsRaw,
    "FLOWAI_TELEGRAM_CHAT_ID",
  );

  let allowed_thread_ids: number[] | undefined;
  const threadIdsRaw = env.get("FLOWAI_TELEGRAM_ALLOWED_THREAD_IDS");
  if (threadIdsRaw !== undefined && threadIdsRaw.trim() !== "") {
    allowed_thread_ids = parseIdList(
      threadIdsRaw.trim(),
      "FLOWAI_TELEGRAM_ALLOWED_THREAD_IDS",
    );
  }

  const ideRaw = requireNonEmpty(env, "FLOWAI_BRIDGE_IDE");
  if (!SUPPORTED_IDES.includes(ideRaw as SupportedIde)) {
    throw new ConfigError(
      `env var 'FLOWAI_BRIDGE_IDE' must be one of: ${
        SUPPORTED_IDES.join(", ")
      }`,
    );
  }

  return {
    token,
    allowed_chat_ids,
    allowed_thread_ids,
    ide: ideRaw as SupportedIde,
    project_dir: cwd,
  };
}
