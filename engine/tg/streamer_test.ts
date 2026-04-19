import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Sender } from "./sender.ts";
import { Streamer } from "./streamer.ts";

interface Recorded {
  method: string;
  body: Record<string, unknown>;
}

function mockSender(): { sender: Sender; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let nextId = 100;
  const fetchFn = ((
    input: Request | URL | string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = url.split("/").pop() ?? "";
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    calls.push({ method, body });
    const payload: Record<string, unknown> = { ok: true };
    if (method === "sendMessage") payload.result = { message_id: nextId++ };
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200 }),
    );
  }) as typeof fetch;
  const sender = new Sender("t", { fetchFn });
  return { sender, calls };
}

/** Manual clock for deterministic tests of debounce & timers. */
class ManualClock {
  time = 0;
  idSeq = 0;
  queue: { id: number; when: number; cb: () => void }[] = [];
  now = (): number => this.time;
  setTimeout = (cb: () => void, ms: number): number => {
    const id = ++this.idSeq;
    this.queue.push({ id, when: this.time + ms, cb });
    this.queue.sort((a, b) => a.when - b.when);
    return id;
  };
  clearTimeout = (id: number): void => {
    this.queue = this.queue.filter((t) => t.id !== id);
  };
  /** Advance time; fire due callbacks synchronously; settle microtasks after. */
  async advance(ms: number): Promise<void> {
    this.time += ms;
    const due: (() => void)[] = [];
    while (this.queue.length > 0 && this.queue[0]!.when <= this.time) {
      due.push(this.queue.shift()!.cb);
    }
    for (const cb of due) cb();
    // Let awaited fetches in flush() resolve before the test asserts.
    for (let i = 0; i < 20; i++) {
      await settleMicrotasks();
    }
  }
}

function settleMicrotasks(): Promise<void> {
  return new Promise<void>((r) => queueMicrotask(() => r()));
}

Deno.test("Streamer.open sends initial placeholder message", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  await streamer.open(42);
  const sends = calls.filter((c) => c.method === "sendMessage");
  assertEquals(sends.length, 1);
  assertEquals(sends[0]!.body.chat_id, 42);
  assert(
    typeof sends[0]!.body.text === "string" &&
      (sends[0]!.body.text as string).length > 0,
  );
});

Deno.test("Streamer.open forwards threadId to sender", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  await streamer.open(42, 9);
  const sends = calls.filter((c) => c.method === "sendMessage");
  assertEquals(sends[0]!.body.message_thread_id, 9);
});

Deno.test("LiveHandle.appendOutput triggers single edit after debounce", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendOutput("first");
  live.appendOutput("second");
  // No edit yet before the debounce window elapses.
  assertEquals(calls.filter((c) => c.method === "editMessageText").length, 0);
  await clock.advance(1000);
  const edits = calls.filter((c) => c.method === "editMessageText");
  assertEquals(edits.length, 1);
  const text = edits[0]!.body.text as string;
  assertStringIncludes(text, "first");
  assertStringIncludes(text, "second");
});

Deno.test("LiveHandle coalesces bursts into at most one edit per second", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  for (let i = 0; i < 20; i++) live.appendOutput(`line ${i}`);
  await clock.advance(1000);
  const edits1 = calls.filter((c) => c.method === "editMessageText").length;
  assertEquals(edits1, 1, "first flush");
  // Another burst: must wait at least another full second for the next edit.
  for (let i = 0; i < 20; i++) live.appendOutput(`more ${i}`);
  await clock.advance(999);
  const edits2 = calls.filter((c) => c.method === "editMessageText").length;
  assertEquals(edits2, 1, "second edit not yet due");
  await clock.advance(1);
  const edits3 = calls.filter((c) => c.method === "editMessageText").length;
  assertEquals(edits3, 2, "second edit fires at t=2000");
});

Deno.test("LiveHandle rolls over to new message when buffer exceeds limit", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({
    sender,
    clock,
    rolloverAt: 100,
  });
  const live = await streamer.open(42);
  live.appendOutput("x".repeat(60));
  live.appendOutput("y".repeat(60));
  await clock.advance(1000);
  const sends = calls.filter((c) => c.method === "sendMessage");
  const edits = calls.filter((c) => c.method === "editMessageText");
  assertEquals(sends.length, 2, "rollover opens a new message");
  assert(edits.length >= 1, "old message finalized via edit");
  const hasMarker = edits.some((e) => String(e.body.text).includes("…"));
  assert(hasMarker, "at least one edit carries the rollover '…' marker");
  for (const c of calls) {
    assert(
      String(c.body.text ?? "").length <= 100,
      `no message/edit exceeds rolloverAt; got ${
        String(c.body.text ?? "").length
      }`,
    );
  }
});

Deno.test("LiveHandle splits a huge final result across multiple messages without exceeding the limit", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const rolloverAt = 100;
  const streamer = new Streamer({ sender, clock, rolloverAt });
  const live = await streamer.open(42);
  // Single append far larger than the per-message limit — must split in finalize.
  live.appendOutput("z".repeat(rolloverAt * 5));
  await live.finalize("ok");
  for (const c of calls) {
    const len = String(c.body.text ?? "").length;
    assert(len <= rolloverAt, `text must fit limit; got ${len}`);
  }
  const sends = calls.filter((c) => c.method === "sendMessage");
  assert(sends.length > 1, "rolled over into multiple messages");
});

Deno.test("LiveHandle.finalize(error) splits huge error output across messages", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const rolloverAt = 100;
  const streamer = new Streamer({ sender, clock, rolloverAt });
  const live = await streamer.open(42);
  live.appendOutput("q".repeat(rolloverAt * 3));
  await live.finalize("error", "boom");
  for (const c of calls) {
    const len = String(c.body.text ?? "").length;
    assert(len <= rolloverAt, `text must fit limit; got ${len}`);
  }
  const edits = calls.filter((c) => c.method === "editMessageText");
  const last = String(edits.at(-1)!.body.text);
  assertStringIncludes(last, "✗");
  assertStringIncludes(last, "boom");
});

Deno.test("LiveHandle.finalize(ok) flushes content without a trailing success marker", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendOutput("done");
  await live.finalize("ok");
  const edits = calls.filter((c) => c.method === "editMessageText");
  assert(edits.length >= 1);
  const last = edits.at(-1)!;
  const text = String(last.body.text);
  assertStringIncludes(text, "done");
  assert(!text.includes("✓"), `OK marker must not appear: ${text}`);
});

Deno.test("LiveHandle.finalize(error) appends error trailer", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  await live.finalize("error", "boom");
  const edits = calls.filter((c) => c.method === "editMessageText");
  assert(edits.length >= 1);
  const text = String(edits.at(-1)!.body.text);
  assertStringIncludes(text, "✗");
  assertStringIncludes(text, "boom");
});

Deno.test("LiveHandle ignores appends after finalize", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  await live.finalize("ok");
  const editsAfterFinalize =
    calls.filter((c) => c.method === "editMessageText").length;
  live.appendOutput("late");
  await clock.advance(5000);
  assertEquals(
    calls.filter((c) => c.method === "editMessageText").length,
    editsAfterFinalize,
    "no edits after finalize",
  );
});

Deno.test("LiveHandle flushes pending buffer during finalize", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendOutput("pending content");
  // Do not advance clock; finalize must force the flush itself.
  await live.finalize("ok");
  const edits = calls.filter((c) => c.method === "editMessageText");
  assert(edits.length >= 1);
  const text = String(edits.at(-1)!.body.text);
  assertStringIncludes(text, "pending content");
});

Deno.test("Streamer sends every API call with parse_mode: HTML", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendOutput("hello");
  await live.finalize("ok");
  assert(calls.length > 0);
  for (const c of calls) {
    assertEquals(
      c.body.parse_mode,
      "HTML",
      `expected parse_mode=HTML on ${c.method}`,
    );
  }
});

Deno.test("LiveHandle strips [stream] and text: prefixes from onOutput lines", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendOutput("[stream] tool: Read engine/cli.ts");
  live.appendOutput("[stream] text: hi");
  await live.finalize("ok");
  const edits = calls.filter((c) => c.method === "editMessageText");
  const text = String(edits.at(-1)!.body.text);
  assert(!text.includes("[stream]"), `[stream] prefix leaked: ${text}`);
  assert(!text.includes("text:"), `text: prefix leaked: ${text}`);
  assertStringIncludes(text, "tool: Read engine/cli.ts");
  assertStringIncludes(text, "hi");
});

Deno.test("LiveHandle wraps stream buffer inside <blockquote expandable>", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendOutput("running tool");
  await live.finalize("ok");
  const edits = calls.filter((c) => c.method === "editMessageText");
  const text = String(edits.at(-1)!.body.text);
  assertStringIncludes(text, "<blockquote expandable>");
  assertStringIncludes(text, "</blockquote>");
  assertStringIncludes(text, "running tool");
});

Deno.test("LiveHandle HTML-escapes <, >, & in stream content", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendOutput("<script>alert('x & y')</script>");
  await live.finalize("ok");
  const edits = calls.filter((c) => c.method === "editMessageText");
  const text = String(edits.at(-1)!.body.text);
  assertStringIncludes(text, "&lt;script&gt;");
  assertStringIncludes(text, "&amp;");
  assert(
    !text.includes("<script>"),
    `raw <script> leaked into body: ${text}`,
  );
});

Deno.test("LiveHandle.appendEvent renders Read tool with 📖 emoji and <code>-wrapped path", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendEvent({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "engine/cli.ts" },
        },
      ],
    },
  });
  await live.finalize("ok");
  const text = String(
    calls.filter((c) => c.method === "editMessageText").at(-1)!.body.text,
  );
  assertStringIncludes(text, "📖");
  assertStringIncludes(text, "<b>Read</b>");
  assertStringIncludes(text, "<code>engine/cli.ts</code>");
});

Deno.test("LiveHandle.appendEvent renders Bash with description fallback", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendEvent({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "ls -la", description: "List dir" },
        },
      ],
    },
  });
  await live.finalize("ok");
  const text = String(
    calls.filter((c) => c.method === "editMessageText").at(-1)!.body.text,
  );
  assertStringIncludes(text, "🐚");
  assertStringIncludes(text, "<b>Bash</b>");
  assertStringIncludes(text, "List dir");
});

Deno.test("LiveHandle.appendEvent renders Bash command in <code> when no description", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendEvent({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
      ],
    },
  });
  await live.finalize("ok");
  const text = String(
    calls.filter((c) => c.method === "editMessageText").at(-1)!.body.text,
  );
  assertStringIncludes(text, "<code>ls -la</code>");
});

Deno.test("LiveHandle.appendEvent renders Grep with pattern and path", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendEvent({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Grep",
          input: { pattern: "foo", path: "engine" },
        },
      ],
    },
  });
  await live.finalize("ok");
  const text = String(
    calls.filter((c) => c.method === "editMessageText").at(-1)!.body.text,
  );
  assertStringIncludes(text, "🔍");
  assertStringIncludes(text, "<code>/foo/</code>");
  assertStringIncludes(text, "<code>engine</code>");
});

Deno.test("LiveHandle.appendEvent renders text block with 💬 emoji", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendEvent({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "thinking out loud" }],
    },
  });
  await live.finalize("ok");
  const text = String(
    calls.filter((c) => c.method === "editMessageText").at(-1)!.body.text,
  );
  assertStringIncludes(text, "💬 thinking out loud");
});

Deno.test("LiveHandle.appendEvent renders system init with model", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendEvent({
    type: "system",
    subtype: "init",
    model: "claude-opus-4-7",
  });
  await live.finalize("ok");
  const text = String(
    calls.filter((c) => c.method === "editMessageText").at(-1)!.body.text,
  );
  assertStringIncludes(text, "⚙️");
  assertStringIncludes(text, "<code>claude-opus-4-7</code>");
});

Deno.test("LiveHandle.appendEvent uses fallback emoji for unknown tool", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendEvent({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "MysteryTool", input: {} }],
    },
  });
  await live.finalize("ok");
  const text = String(
    calls.filter((c) => c.method === "editMessageText").at(-1)!.body.text,
  );
  assertStringIncludes(text, "🛠️");
  assertStringIncludes(text, "<b>MysteryTool</b>");
});

Deno.test("LiveHandle.appendEvent escapes HTML in tool input", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendEvent({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "echo '<script>'" },
        },
      ],
    },
  });
  await live.finalize("ok");
  const text = String(
    calls.filter((c) => c.method === "editMessageText").at(-1)!.body.text,
  );
  assertStringIncludes(text, "&lt;script&gt;");
  assert(!text.includes("<script>"), "raw <script> must not leak");
});

Deno.test("LiveHandle.appendEvent skips unknown event types", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendEvent({ type: "result", subtype: "success" });
  live.appendEvent({ type: "user", message: { content: [] } });
  await live.finalize("ok");
  const edits = calls.filter((c) => c.method === "editMessageText");
  // No content rendered → finalize should produce no edit (or empty body skipped).
  assertEquals(
    edits.length,
    0,
    `unknown events must not emit edits, got: ${
      edits.map((e) => e.body.text).join(" | ")
    }`,
  );
});

Deno.test("LiveHandle.appendFinal renders final text outside the blockquote", async () => {
  const { sender, calls } = mockSender();
  const clock = new ManualClock();
  const streamer = new Streamer({ sender, clock });
  const live = await streamer.open(42);
  live.appendOutput("progress step");
  live.appendFinal("the answer");
  await live.finalize("ok");
  const edits = calls.filter((c) => c.method === "editMessageText");
  const text = String(edits.at(-1)!.body.text);
  const closeIdx = text.indexOf("</blockquote>");
  const finalIdx = text.indexOf("the answer");
  assert(closeIdx > 0, "blockquote present");
  assert(finalIdx > closeIdx, "final text must appear after </blockquote>");
  // And "the answer" is not inside the blockquote region.
  const bqBody = text.slice(
    text.indexOf("<blockquote expandable>"),
    closeIdx,
  );
  assert(
    !bqBody.includes("the answer"),
    "final text leaked into blockquote",
  );
});
