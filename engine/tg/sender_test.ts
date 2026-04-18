import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CHUNK_LIMIT, chunkText, Sender } from "./sender.ts";

Deno.test("chunkText returns single chunk for short text", () => {
  assertEquals(chunkText("hello"), ["hello"]);
});

Deno.test("chunkText returns single chunk at exact limit", () => {
  const s = "a".repeat(CHUNK_LIMIT);
  assertEquals(chunkText(s), [s]);
});

Deno.test("chunkText splits on newline when available in window", () => {
  const block = "line\n".repeat(1000);
  const chunks = chunkText(block);
  assert(chunks.length >= 2);
  for (const c of chunks) {
    assert(c.length <= CHUNK_LIMIT);
  }
  assertEquals(chunks.join(""), block, "lossless concat");
  for (const c of chunks.slice(0, -1)) {
    assert(c.endsWith("\n"), `chunk should end at newline: ${c.at(-1)}`);
  }
});

Deno.test("chunkText hard-cuts when no newline in window", () => {
  const s = "x".repeat(CHUNK_LIMIT + 500);
  const chunks = chunkText(s);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0]!.length, CHUNK_LIMIT);
  assertEquals(chunks[1]!.length, 500);
  assertEquals(chunks.join(""), s);
});

Deno.test("chunkText is lossless for mixed content", () => {
  const parts: string[] = [];
  for (let i = 0; i < 20; i++) {
    parts.push("a".repeat(300), "\n");
  }
  parts.push("z".repeat(CHUNK_LIMIT + 10));
  const input = parts.join("");
  const chunks = chunkText(input);
  assertEquals(chunks.join(""), input);
  for (const c of chunks) {
    assert(c.length <= CHUNK_LIMIT);
  }
});

Deno.test("chunkText handles empty string", () => {
  assertEquals(chunkText(""), [""]);
});

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

function mockFetch(
  responses: Array<{ ok: boolean; status?: number; body: unknown }>,
): { fetchFn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let idx = 0;
  const fetchFn = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const body = bodyStr ? JSON.parse(bodyStr) as Record<string, unknown> : {};
    calls.push({ url, body });
    const r = responses[idx++] ?? responses[responses.length - 1]!;
    const res = new Response(JSON.stringify(r.body), {
      status: r.status ?? (r.ok ? 200 : 400),
    });
    return await Promise.resolve(res);
  }) as typeof fetch;
  return { fetchFn, calls };
}

Deno.test("Sender.send posts JSON body to sendMessage", async () => {
  const { fetchFn, calls } = mockFetch([
    { ok: true, body: { ok: true, result: { message_id: 10 } } },
  ]);
  const sender = new Sender("123:SECRET_TOKEN", { fetchFn });
  await sender.send(42, "hello");
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0]!.url, "/sendMessage");
  assertEquals(calls[0]!.body.chat_id, 42);
  assertEquals(calls[0]!.body.text, "hello");
});

Deno.test("Sender.send returns messageId from Telegram response", async () => {
  const { fetchFn } = mockFetch([
    { ok: true, body: { ok: true, result: { message_id: 777 } } },
  ]);
  const sender = new Sender("t", { fetchFn });
  const res = await sender.send(1, "hi");
  assertEquals(res.messageId, 777);
});

Deno.test("Sender.edit posts to editMessageText with ids", async () => {
  const { fetchFn, calls } = mockFetch([{ ok: true, body: { ok: true } }]);
  const sender = new Sender("t", { fetchFn });
  await sender.edit(42, 5, "updated");
  assertStringIncludes(calls[0]!.url, "/editMessageText");
  assertEquals(calls[0]!.body.chat_id, 42);
  assertEquals(calls[0]!.body.message_id, 5);
  assertEquals(calls[0]!.body.text, "updated");
});

Deno.test("Sender.send includes message_thread_id when given", async () => {
  const { fetchFn, calls } = mockFetch([
    { ok: true, body: { ok: true, result: { message_id: 1 } } },
  ]);
  const sender = new Sender("t", { fetchFn });
  await sender.send(42, "hi", 7);
  assertEquals(calls[0]!.body.message_thread_id, 7);
});

Deno.test("Sender.setMyCommands posts to setMyCommands with commands array", async () => {
  const { fetchFn, calls } = mockFetch([{ ok: true, body: { ok: true } }]);
  const sender = new Sender("t", { fetchFn });
  await sender.setMyCommands([
    { command: "reset", description: "clear session" },
    { command: "settings", description: "show settings" },
  ]);
  assertStringIncludes(calls[0]!.url, "/setMyCommands");
  assertEquals(calls[0]!.body.commands, [
    { command: "reset", description: "clear session" },
    { command: "settings", description: "show settings" },
  ]);
});

Deno.test("Sender.sendChatAction posts action=typing", async () => {
  const { fetchFn, calls } = mockFetch([{ ok: true, body: { ok: true } }]);
  const sender = new Sender("t", { fetchFn });
  await sender.sendChatAction(42, "typing");
  assertStringIncludes(calls[0]!.url, "/sendChatAction");
  assertEquals(calls[0]!.body.action, "typing");
});

Deno.test("Sender retries on network error, then succeeds", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls < 3) throw new Error("econnrefused");
    return await Promise.resolve(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  const sleeps: number[] = [];
  const sender = new Sender("t", {
    fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  await sender.send(1, "hi");
  assertEquals(calls, 3);
  assertEquals(sleeps, [1000, 2000]);
});

Deno.test("Sender throws sanitized error when token appears in response", async () => {
  const fetchFn = (async () => {
    return await Promise.resolve(
      new Response(
        JSON.stringify({
          ok: false,
          description:
            "url: https://api.telegram.org/bot1:ABCxyz-1/sendMessage failed",
        }),
        { status: 400 },
      ),
    );
  }) as typeof fetch;
  const sender = new Sender("1:ABCxyz-1", {
    fetchFn,
    maxRetries: 0,
    sleep: () => Promise.resolve(),
  });
  let caught = "";
  try {
    await sender.send(1, "hi");
  } catch (e) {
    caught = e instanceof Error ? e.message : String(e);
  }
  assert(caught.length > 0, "expected error to be thrown");
  assert(!caught.includes("1:ABCxyz-1"), `token leaked: ${caught}`);
  assertStringIncludes(caught, "bot<REDACTED>");
});

Deno.test("Sender.getMe returns bot info on success", async () => {
  const { fetchFn } = mockFetch([
    { ok: true, body: { ok: true, result: { id: 9, username: "b" } } },
  ]);
  const sender = new Sender("t", { fetchFn });
  const me = await sender.getMe();
  assertEquals(me.id, 9);
  assertEquals(me.username, "b");
});
