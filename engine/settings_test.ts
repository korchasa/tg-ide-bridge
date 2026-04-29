import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_SETTINGS,
  effectiveSettings,
  formatSettings,
  validateEffort,
  validateMaxRetries,
  validateModel,
  validatePermissionMode,
  validateRetryDelaySeconds,
  validateTimeoutSeconds,
  WHITELISTS,
} from "./settings.ts";

Deno.test("effectiveSettings fills numeric defaults when stored is empty", () => {
  const eff = effectiveSettings({});
  assertEquals(eff.timeoutSeconds, DEFAULT_SETTINGS.timeoutSeconds);
  assertEquals(eff.maxRetries, DEFAULT_SETTINGS.maxRetries);
  assertEquals(eff.retryDelaySeconds, DEFAULT_SETTINGS.retryDelaySeconds);
  assertEquals(eff.model, undefined);
  assertEquals(eff.effort, undefined);
  assertEquals(eff.permissionMode, undefined);
});

Deno.test("effectiveSettings preserves overrides", () => {
  const eff = effectiveSettings({
    timeoutSeconds: 42,
    model: "opus",
    effort: "high",
    permissionMode: "acceptEdits",
  });
  assertEquals(eff.timeoutSeconds, 42);
  assertEquals(eff.model, "opus");
  assertEquals(eff.effort, "high");
  assertEquals(eff.permissionMode, "acceptEdits");
  assertEquals(eff.maxRetries, DEFAULT_SETTINGS.maxRetries);
});

Deno.test("validateModel accepts values in claude whitelist", () => {
  for (const m of WHITELISTS.claude.models) {
    const r = validateModel("claude", m);
    assert(r.ok, `expected '${m}' to validate`);
    if (r.ok) assertEquals(r.value, m);
  }
});

Deno.test("validateModel rejects value outside whitelist with helpful error", () => {
  const r = validateModel("claude", "gpt-5");
  assert(!r.ok);
  if (!r.ok) {
    assert(r.error.includes("gpt-5"));
    assert(r.error.includes("sonnet"));
  }
});

Deno.test("validateEffort rejects for ide with empty effort whitelist", () => {
  const r = validateEffort("opencode", "high");
  assert(!r.ok);
  if (!r.ok) assert(r.error.includes("not supported"));
});

Deno.test("validateEffort accepts claude whitelist", () => {
  for (const e of WHITELISTS.claude.efforts) {
    assert(validateEffort("claude", e).ok);
  }
});

Deno.test("validateEffort accepts codex whitelist (typed ReasoningEffort)", () => {
  for (const e of WHITELISTS.codex.efforts) {
    assert(validateEffort("codex", e).ok);
  }
  assertEquals(WHITELISTS.codex.efforts, ["minimal", "low", "medium", "high"]);
});

Deno.test("validatePermissionMode rejects for cursor (empty whitelist)", () => {
  const r = validatePermissionMode("cursor", "acceptEdits");
  assert(!r.ok);
  if (!r.ok) assert(r.error.includes("not supported"));
});

Deno.test("validatePermissionMode accepts claude values", () => {
  for (const p of WHITELISTS.claude.permissionModes) {
    assert(validatePermissionMode("claude", p).ok);
  }
});

Deno.test("validateTimeoutSeconds accepts values in [1, 3600]", () => {
  const ok = validateTimeoutSeconds("600");
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.value, 600);
});

Deno.test("validateTimeoutSeconds rejects zero and above max", () => {
  assert(!validateTimeoutSeconds("0").ok);
  assert(!validateTimeoutSeconds("3601").ok);
  assert(!validateTimeoutSeconds("abc").ok);
});

Deno.test("validateMaxRetries requires integer in [0, 10]", () => {
  assert(validateMaxRetries("0").ok);
  assert(validateMaxRetries("10").ok);
  assert(!validateMaxRetries("11").ok);
  assert(!validateMaxRetries("-1").ok);
  assert(!validateMaxRetries("1.5").ok);
});

Deno.test("validateRetryDelaySeconds allows zero, fractional, caps at 60", () => {
  assert(validateRetryDelaySeconds("0").ok);
  const frac = validateRetryDelaySeconds("1.5");
  assert(frac.ok);
  if (frac.ok) assertEquals(frac.value, 1.5);
  assert(!validateRetryDelaySeconds("61").ok);
});

Deno.test("formatSettings marks unset numeric fields as (default)", () => {
  const out = formatSettings("claude", {});
  assert(out.includes("ide: claude"));
  assert(out.includes("model: —"));
  assert(out.includes("timeoutSeconds: 600 (default)"));
  assert(out.includes("maxRetries: 1 (default)"));
});

Deno.test("formatSettings shows stored override without default marker", () => {
  const out = formatSettings("claude", { model: "opus", timeoutSeconds: 42 });
  assert(out.includes("model: opus"));
  assert(!out.includes("model: opus (default)"));
  assert(out.includes("timeoutSeconds: 42"));
  assert(!out.includes("timeoutSeconds: 42 (default)"));
});
