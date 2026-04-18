import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError, loadConfig } from "./config.ts";

function envOf(vars: Record<string, string | undefined>) {
  return { get: (k: string) => vars[k] };
}

function baseEnv(extra: Record<string, string | undefined> = {}) {
  return envOf({
    FLOWAI_TELEGRAM_BOT_TOKEN: "123:SECRET",
    FLOWAI_TELEGRAM_CHAT_ID: "111,222",
    FLOWAI_BRIDGE_IDE: "claude",
    ...extra,
  });
}

Deno.test("loadConfig returns validated config from env", () => {
  const cfg = loadConfig(baseEnv(), { cwd: "/tmp" });
  assertEquals(cfg.token, "123:SECRET");
  assertEquals(cfg.allowed_chat_ids, [111, 222]);
  assertEquals(cfg.ide, "claude");
  assertEquals(cfg.project_dir, "/tmp");
});

Deno.test("loadConfig uses Deno.cwd() when opts.cwd is absent", () => {
  const cfg = loadConfig(baseEnv());
  assertEquals(cfg.project_dir, Deno.cwd());
});

Deno.test("loadConfig throws when token missing", () => {
  const env = envOf({
    FLOWAI_TELEGRAM_CHAT_ID: "1",
    FLOWAI_BRIDGE_IDE: "claude",
  });
  assertThrows(
    () => loadConfig(env, { cwd: "/tmp" }),
    ConfigError,
    "FLOWAI_TELEGRAM_BOT_TOKEN",
  );
});

Deno.test("loadConfig rejects empty token", () => {
  assertThrows(
    () =>
      loadConfig(baseEnv({ FLOWAI_TELEGRAM_BOT_TOKEN: "   " }), {
        cwd: "/tmp",
      }),
    ConfigError,
    "FLOWAI_TELEGRAM_BOT_TOKEN",
  );
});

Deno.test("loadConfig rejects invalid ide", () => {
  assertThrows(
    () => loadConfig(baseEnv({ FLOWAI_BRIDGE_IDE: "emacs" }), { cwd: "/tmp" }),
    ConfigError,
    "FLOWAI_BRIDGE_IDE",
  );
});

Deno.test("loadConfig rejects missing allowed_chat_ids", () => {
  const env = envOf({
    FLOWAI_TELEGRAM_BOT_TOKEN: "t",
    FLOWAI_BRIDGE_IDE: "claude",
  });
  assertThrows(
    () => loadConfig(env, { cwd: "/tmp" }),
    ConfigError,
    "FLOWAI_TELEGRAM_CHAT_ID",
  );
});

Deno.test("loadConfig rejects non-numeric chat id", () => {
  assertThrows(
    () =>
      loadConfig(baseEnv({ FLOWAI_TELEGRAM_CHAT_ID: "1,abc" }), {
        cwd: "/tmp",
      }),
    ConfigError,
    "'abc'",
  );
});

Deno.test("loadConfig accepts allowed_thread_ids when present", () => {
  const cfg = loadConfig(
    baseEnv({ FLOWAI_TELEGRAM_ALLOWED_THREAD_IDS: "10, 20" }),
    { cwd: "/tmp" },
  );
  assertEquals(cfg.allowed_thread_ids, [10, 20]);
});

Deno.test("loadConfig treats empty allowed_thread_ids as absent", () => {
  const cfg = loadConfig(
    baseEnv({ FLOWAI_TELEGRAM_ALLOWED_THREAD_IDS: "  " }),
    { cwd: "/tmp" },
  );
  assertEquals(cfg.allowed_thread_ids, undefined);
});

Deno.test("loadConfig ignores removed IDE tuning env vars", () => {
  // These are no longer honored — runtime settings come from session.json.
  const cfg = loadConfig(
    baseEnv({
      FLOWAI_BRIDGE_IDE_TIMEOUT_SECONDS: "42",
      FLOWAI_BRIDGE_IDE_MAX_RETRIES: "5",
      FLOWAI_BRIDGE_IDE_MODEL: "opus",
      FLOWAI_BRIDGE_IDE_EFFORT: "high",
      FLOWAI_BRIDGE_IDE_PERMISSION_MODE: "acceptEdits",
    }),
    { cwd: "/tmp" },
  );
  // No such fields on the type; accessing them returns undefined.
  assertEquals(
    (cfg as unknown as Record<string, unknown>).ide_timeout_seconds,
    undefined,
  );
  assertEquals(
    (cfg as unknown as Record<string, unknown>).ide_model,
    undefined,
  );
});
