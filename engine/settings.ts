/**
 * @module
 * Runtime-tunable IDE settings. Unlike `Config` (deploy-time env), these
 * settings are owned by the user via Telegram commands and persisted in
 * `.tg-ide-bridge/session.json` alongside the `--resume` token.
 *
 * - `StoredSettings` — on-disk shape; every field optional.
 * - `EffectiveSettings` — after applying code defaults; numeric fields required.
 * - Whitelists constrain `model`/`effort`/`permissionMode` per IDE.
 */

import type { SupportedIde } from "./config.ts";

export interface StoredSettings {
  model?: string;
  effort?: string;
  permissionMode?: string;
  timeoutSeconds?: number;
  maxRetries?: number;
  retryDelaySeconds?: number;
}

export interface EffectiveSettings {
  model?: string;
  effort?: string;
  permissionMode?: string;
  timeoutSeconds: number;
  maxRetries: number;
  retryDelaySeconds: number;
}

export const DEFAULT_SETTINGS = {
  timeoutSeconds: 600,
  maxRetries: 1,
  retryDelaySeconds: 2,
} as const;

export interface NumericRange {
  min: number;
  max: number;
  integer?: boolean;
}

export const NUMERIC_RANGES: Record<
  "timeoutSeconds" | "maxRetries" | "retryDelaySeconds",
  NumericRange
> = {
  timeoutSeconds: { min: 1, max: 3600 },
  maxRetries: { min: 0, max: 10, integer: true },
  retryDelaySeconds: { min: 0, max: 60 },
};

export interface IdeWhitelist {
  models: readonly string[];
  efforts: readonly string[];
  permissionModes: readonly string[];
}

export const WHITELISTS: Record<SupportedIde, IdeWhitelist> = {
  claude: {
    models: [
      "sonnet",
      "opus",
      "haiku",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-5",
      "claude-opus-4-7",
      "claude-haiku-4-5",
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    permissionModes: [
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions",
    ],
  },
  opencode: {
    models: [
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-opus-4-5",
      "openai/gpt-5",
      "google/gemini-2.5-pro",
    ],
    efforts: [],
    permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
  },
  cursor: {
    models: ["auto", "sonnet", "opus", "gpt-5"],
    efforts: [],
    permissionModes: [],
  },
  codex: {
    // Common OpenAI models; codex accepts any via `-m`, whitelist only
    // constrains the TG `/model` command surface.
    models: ["gpt-5", "gpt-5-codex", "o3", "o4-mini"],
    // Mirrors ai-ide-cli's typed `ReasoningEffort` enum (1:1 map onto
    // Codex's native `model_reasoning_effort`). Forwarded as the typed
    // `reasoningEffort` field, not via `extraArgs`.
    efforts: ["minimal", "low", "medium", "high"],
    // ai-ide-cli translates these to `--sandbox`/`approval_policy` overrides.
    permissionModes: [
      "default",
      "plan",
      "acceptEdits",
      "bypassPermissions",
    ],
  },
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function validateEnum(
  ide: SupportedIde,
  field: "model" | "effort" | "permissionMode",
  allowed: readonly string[],
  value: string,
): ValidationResult<string> {
  if (allowed.length === 0) {
    return {
      ok: false,
      error: `${field} is not supported for ide '${ide}'`,
    };
  }
  if (!allowed.includes(value)) {
    return {
      ok: false,
      error: `invalid ${field} '${value}' for ide '${ide}'; allowed: ${
        allowed.join(", ")
      }`,
    };
  }
  return { ok: true, value };
}

export function validateModel(
  ide: SupportedIde,
  value: string,
): ValidationResult<string> {
  return validateEnum(ide, "model", WHITELISTS[ide].models, value);
}

export function validateEffort(
  ide: SupportedIde,
  value: string,
): ValidationResult<string> {
  return validateEnum(ide, "effort", WHITELISTS[ide].efforts, value);
}

export function validatePermissionMode(
  ide: SupportedIde,
  value: string,
): ValidationResult<string> {
  return validateEnum(
    ide,
    "permissionMode",
    WHITELISTS[ide].permissionModes,
    value,
  );
}

function validateNumber(
  field: keyof typeof NUMERIC_RANGES,
  raw: string,
): ValidationResult<number> {
  const r = NUMERIC_RANGES[field];
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${field} must be a number; got '${raw}'` };
  }
  if (r.integer && !Number.isInteger(n)) {
    return { ok: false, error: `${field} must be an integer; got '${raw}'` };
  }
  if (n < r.min || n > r.max) {
    return {
      ok: false,
      error: `${field} must be in [${r.min}, ${r.max}]; got ${n}`,
    };
  }
  return { ok: true, value: n };
}

export function validateTimeoutSeconds(raw: string): ValidationResult<number> {
  return validateNumber("timeoutSeconds", raw);
}

export function validateMaxRetries(raw: string): ValidationResult<number> {
  return validateNumber("maxRetries", raw);
}

export function validateRetryDelaySeconds(
  raw: string,
): ValidationResult<number> {
  return validateNumber("retryDelaySeconds", raw);
}

/** Merge stored settings with code defaults. */
export function effectiveSettings(
  stored: StoredSettings,
): EffectiveSettings {
  return {
    model: stored.model,
    effort: stored.effort,
    permissionMode: stored.permissionMode,
    timeoutSeconds: stored.timeoutSeconds ?? DEFAULT_SETTINGS.timeoutSeconds,
    maxRetries: stored.maxRetries ?? DEFAULT_SETTINGS.maxRetries,
    retryDelaySeconds: stored.retryDelaySeconds ??
      DEFAULT_SETTINGS.retryDelaySeconds,
  };
}

/** Format effective settings as a human-readable multi-line string for TG. */
export function formatSettings(
  ide: SupportedIde,
  stored: StoredSettings,
): string {
  const eff = effectiveSettings(stored);
  const ov = (key: keyof StoredSettings) =>
    stored[key] === undefined ? " (default)" : "";
  const fmt = (val: string | undefined, key: keyof StoredSettings) =>
    val === undefined ? "—" : `${val}${ov(key)}`;
  const lines = [
    `ide: ${ide}`,
    `model: ${fmt(eff.model, "model")}`,
    `effort: ${fmt(eff.effort, "effort")}`,
    `permissionMode: ${fmt(eff.permissionMode, "permissionMode")}`,
    `timeoutSeconds: ${eff.timeoutSeconds}${ov("timeoutSeconds")}`,
    `maxRetries: ${eff.maxRetries}${ov("maxRetries")}`,
    `retryDelaySeconds: ${eff.retryDelaySeconds}${ov("retryDelaySeconds")}`,
  ];
  return lines.join("\n");
}
