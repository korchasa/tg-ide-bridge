/**
 * @module
 * Map runtime-tunable `effort` setting to the right `ai-ide-cli` invocation
 * field, per IDE.
 *
 * - **Claude**: raw passthrough via `extraArgs: { "--effort": <val> }`.
 *   The TG whitelist includes `xhigh`/`max`, which are outside the typed
 *   `ReasoningEffort` enum, so the typed field would reject them.
 * - **Codex**: typed `reasoningEffort`; whitelist (`minimal|low|medium|high`)
 *   matches the enum 1:1, so the cast is safe at the call site.
 * - **OpenCode/Cursor**: `/effort` whitelist is empty; settings validation
 *   rejects the field, so we never reach this helper with a value set.
 *
 * Returns a partial of `RuntimeInvokeOptions` / `RuntimeSessionOptions` so
 * call sites can spread it directly.
 */

import type { ExtraArgsMap, ReasoningEffort } from "@korchasa/ai-ide-cli";
import type { SupportedIde } from "./config.ts";

export interface EffortInvokeFields {
  extraArgs?: ExtraArgsMap;
  reasoningEffort?: ReasoningEffort;
}

// FR-SETTINGS
export function effortToInvokeFields(
  ide: SupportedIde,
  effort: string | undefined,
): EffortInvokeFields {
  if (!effort) return {};
  if (ide === "claude") return { extraArgs: { "--effort": effort } };
  if (ide === "codex") return { reasoningEffort: effort as ReasoningEffort };
  return {};
}
