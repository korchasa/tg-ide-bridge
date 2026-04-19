import { assertEquals } from "@std/assert";
import { isAllowed } from "./auth.ts";
import type { Config } from "./config.ts";
import type { TgUpdate } from "./tg/types.ts";

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    token: "t",
    allowed_chat_ids: [100, 200],
    ide: "claude",
    project_dir: "/tmp",
    ...overrides,
  };
}

function upd(chatId: number, threadId?: number): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId },
      message_thread_id: threadId,
      text: "hi",
    },
  };
}

Deno.test("isAllowed accepts whitelisted chat without thread config", () => {
  assertEquals(isAllowed(upd(100), cfg()), true);
  assertEquals(isAllowed(upd(200, 5), cfg()), true);
});

Deno.test("isAllowed rejects non-whitelisted chat", () => {
  assertEquals(isAllowed(upd(999), cfg()), false);
});

Deno.test("isAllowed rejects update without message", () => {
  assertEquals(isAllowed({ update_id: 1 }, cfg()), false);
});

Deno.test("isAllowed enforces thread whitelist when configured", () => {
  const c = cfg({ allowed_thread_ids: [10, 20] });
  assertEquals(isAllowed(upd(100, 10), c), true);
  assertEquals(isAllowed(upd(100, 20), c), true);
  assertEquals(isAllowed(upd(100, 30), c), false);
  assertEquals(isAllowed(upd(100), c), false);
});

Deno.test("isAllowed ignores thread when thread whitelist empty/absent", () => {
  assertEquals(isAllowed(upd(100, 42), cfg()), true);
  assertEquals(isAllowed(upd(100, 42), cfg({ allowed_thread_ids: [] })), true);
});
