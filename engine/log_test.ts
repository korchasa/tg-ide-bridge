import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLogger, sanitizeError } from "./log.ts";

Deno.test("sanitizeError strips bot token from URL", () => {
  const input =
    "GET https://api.telegram.org/bot123456:ABCDEF_xyz-123/getMe failed";
  const out = sanitizeError(input);
  assertEquals(
    out,
    "GET https://api.telegram.org/bot<REDACTED>/getMe failed",
  );
});

Deno.test("sanitizeError strips bot token from Error", () => {
  const err = new Error("call to bot9:sEcReT_TOKEN-1 failed");
  const out = sanitizeError(err);
  assertStringIncludes(out, "bot<REDACTED>");
});

Deno.test("logger emits JSON lines and sanitizes fields", () => {
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));
  log.info("hello", {
    url: "https://api.telegram.org/bot1:TOKEN123/sendMessage",
  });
  assertEquals(lines.length, 1);
  const rec = JSON.parse(lines[0]!);
  assertEquals(rec.level, "info");
  assertEquals(rec.msg, "hello");
  assertStringIncludes(rec.url as string, "bot<REDACTED>");
});
