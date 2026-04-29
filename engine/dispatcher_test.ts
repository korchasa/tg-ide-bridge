import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Dispatcher } from "./dispatcher.ts";
import type { Config } from "./config.ts";
import type { TgUpdate } from "./tg/types.ts";
import { Sender } from "./tg/sender.ts";
import { Streamer } from "./tg/streamer.ts";
import { SessionStore } from "./session.ts";
import type {
  CliRunOutput,
  RuntimeAdapter,
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
} from "@korchasa/ai-ide-cli";
import { createLogger } from "./log.ts";

function silentLog() {
  return createLogger(() => {});
}

interface Recorded {
  method: string;
  body: Record<string, unknown>;
}

function fakeFetch(): {
  fetchFn: typeof fetch;
  calls: Recorded[];
  setDelay: (ms: number) => void;
} {
  const calls: Recorded[] = [];
  let delay = 0;
  let nextMessageId = 1;
  const fetchFn = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = url.split("/").pop() ?? "";
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    calls.push({ method, body });
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    const payload: Record<string, unknown> = { ok: true };
    if (method === "sendMessage") {
      payload.result = { message_id: nextMessageId++ };
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls, setDelay: (ms) => (delay = ms) };
}

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    token: "t",
    allowed_chat_ids: [1],
    ide: "claude",
    project_dir: "/tmp",
    ...overrides,
  };
}

function msg(text: string, threadId?: number): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 1 },
      message_thread_id: threadId,
      text,
    },
  };
}

function okOutput(overrides: Partial<CliRunOutput> = {}): CliRunOutput {
  return {
    runtime: "claude",
    result: "ok",
    session_id: "sess-1",
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    is_error: false,
    ...overrides,
  };
}

class FakeAdapter implements RuntimeAdapter {
  id = "claude" as const;
  capabilities = {
    permissionMode: true,
    hitl: false,
    transcript: false,
    interactive: true,
    toolUseObservation: false,
    session: false,
    capabilityInventory: false,
    toolFilter: false,
    reasoningEffort: false,
  };
  calls: RuntimeInvokeOptions[] = [];
  result: RuntimeInvokeResult = { output: okOutput() };
  #delayMs = 0;
  #handler?: (opts: RuntimeInvokeOptions) => RuntimeInvokeResult;
  setDelay(ms: number) {
    this.#delayMs = ms;
  }
  setHandler(h: (opts: RuntimeInvokeOptions) => RuntimeInvokeResult) {
    this.#handler = h;
  }
  async invoke(opts: RuntimeInvokeOptions): Promise<RuntimeInvokeResult> {
    this.calls.push(opts);
    if (this.#delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.#delayMs));
    }
    if (this.#handler) return await Promise.resolve(this.#handler(opts));
    return await Promise.resolve(this.result);
  }
  launchInteractive(): Promise<{ exitCode: number }> {
    return Promise.resolve({ exitCode: 0 });
  }
}

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("Dispatcher echoes text when no IDE is configured", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const d = new Dispatcher({ cfg: cfg(), sender, log: silentLog() });
  await d.handle(msg("hello"));
  const sent = calls.find((c) => c.method === "sendMessage");
  assertEquals(sent?.body.text, "hello");
});

Deno.test("Dispatcher ignores updates with no message", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const d = new Dispatcher({ cfg: cfg(), sender, log: silentLog() });
  await d.handle({ update_id: 1 });
  assertEquals(calls.length, 0);
});

Deno.test("Dispatcher invokes IDE with default effective settings", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    ide.result = { output: okOutput({ result: "pong", session_id: "s" }) };
    const session = new SessionStore(dir, "claude");
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      ide,
      session,
      log: silentLog(),
    });
    await d.handle(msg("ping"));
    assertEquals(ide.calls.length, 1);
    assertEquals(ide.calls[0]!.taskPrompt, "ping");
    assertEquals(ide.calls[0]!.cwd, dir);
    assertEquals(ide.calls[0]!.timeoutSeconds, 600);
    assertEquals(ide.calls[0]!.maxRetries, 1);
    assertEquals(ide.calls[0]!.retryDelaySeconds, 2);
    assertEquals(ide.calls[0]!.permissionMode, undefined);
    assertEquals(ide.calls[0]!.model, undefined);
    assertEquals(ide.calls[0]!.extraArgs, undefined);
    const sends = calls.filter((c) => c.method === "sendMessage");
    assertEquals(sends.length, 1);
    assertEquals(sends[0]!.body.text, "pong");
  });
});

Deno.test("Dispatcher applies stored settings to IDE invocation", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "claude");
    await session.saveSettings({
      model: "opus",
      effort: "high",
      permissionMode: "acceptEdits",
      timeoutSeconds: 42,
      maxRetries: 3,
      retryDelaySeconds: 5,
    });
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      ide,
      session,
      log: silentLog(),
    });
    await d.handle(msg("ping"));
    const call = ide.calls[0]!;
    assertEquals(call.model, "opus");
    assertEquals(call.permissionMode, "acceptEdits");
    assertEquals(call.timeoutSeconds, 42);
    assertEquals(call.maxRetries, 3);
    assertEquals(call.retryDelaySeconds, 5);
    assertEquals(call.extraArgs, { "--effort": "high" });
  });
});

Deno.test("Dispatcher omits --effort for non-claude ides", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "claude");
    await session.saveSettings({ effort: "high" });
    const d = new Dispatcher({
      cfg: cfg({ ide: "opencode", project_dir: dir }),
      sender,
      ide,
      session,
      log: silentLog(),
    });
    await d.handle(msg("ping"));
    assertEquals(ide.calls[0]!.extraArgs, undefined);
    assertEquals(ide.calls[0]!.reasoningEffort, undefined);
  });
});

Deno.test("Dispatcher maps effort to typed reasoningEffort for codex", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "codex");
    await session.saveSettings({ effort: "high" });
    const d = new Dispatcher({
      cfg: cfg({ ide: "codex", project_dir: dir }),
      sender,
      ide,
      session,
      log: silentLog(),
    });
    await d.handle(msg("ping"));
    const call = ide.calls[0]!;
    assertEquals(call.reasoningEffort, "high");
    assertEquals(call.extraArgs, undefined);
  });
});

Deno.test("Dispatcher /effort high on codex stores setting", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "codex");
    const d = new Dispatcher({
      cfg: cfg({ ide: "codex", project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/effort high"));
    const reply = calls.at(-1)!.body.text as string;
    assertStringIncludes(reply, "effort set");
    assertEquals((await session.loadSettings()).effort, "high");
  });
});

Deno.test("Dispatcher reports IDE error to chat", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const ide = new FakeAdapter();
  ide.result = { error: "runtime crashed" };
  const d = new Dispatcher({ cfg: cfg(), sender, ide, log: silentLog() });
  await d.handle(msg("run"));
  const sends = calls.filter((c) => c.method === "sendMessage");
  assertEquals(sends.length, 1);
  assertStringIncludes(sends[0]!.body.text as string, "IDE error");
  assertStringIncludes(sends[0]!.body.text as string, "runtime crashed");
});

Deno.test("Dispatcher reports is_error=true from runtime output", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const ide = new FakeAdapter();
  ide.result = {
    output: okOutput({ is_error: true, result: "partial failure" }),
  };
  const d = new Dispatcher({ cfg: cfg(), sender, ide, log: silentLog() });
  await d.handle(msg("run"));
  const sends = calls.filter((c) => c.method === "sendMessage");
  assertEquals(sends.length, 1);
  assertStringIncludes(sends[0]!.body.text as string, "IDE error");
  assertStringIncludes(sends[0]!.body.text as string, "partial failure");
});

Deno.test("Dispatcher serializes overlapping handle() calls", async () => {
  const { fetchFn } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const ide = new FakeAdapter();
  const order: string[] = [];
  ide.invoke = (opts: RuntimeInvokeOptions) => {
    order.push(`start:${opts.taskPrompt}`);
    return new Promise((r) => {
      setTimeout(() => {
        order.push(`end:${opts.taskPrompt}`);
        r({
          output: okOutput({
            result: opts.taskPrompt,
            session_id: "s",
          }),
        });
      }, 20);
    });
  };
  const d = new Dispatcher({ cfg: cfg(), sender, ide, log: silentLog() });
  await Promise.all([
    d.handle(msg("a")),
    d.handle(msg("b")),
    d.handle(msg("c")),
  ]);
  assertEquals(order, [
    "start:a",
    "end:a",
    "start:b",
    "end:b",
    "start:c",
    "end:c",
  ]);
});

Deno.test("Dispatcher persists session token and resumes on next call", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "claude");
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      ide,
      session,
      log: silentLog(),
    });

    ide.result = {
      output: okOutput({ result: "first", session_id: "sess-first" }),
    };
    await d.handle(msg("hi"));
    assertEquals(ide.calls[0]!.resumeSessionId, undefined);
    assertEquals(await session.loadSession(), "sess-first");

    ide.result = {
      output: okOutput({ result: "second", session_id: "sess-second" }),
    };
    await d.handle(msg("follow up"));
    assertEquals(ide.calls[1]!.resumeSessionId, "sess-first");
    assertEquals(await session.loadSession(), "sess-second");
  });
});

Deno.test("Dispatcher /reset clears session and next call omits resume", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "claude");
    await session.saveSession("prev-token");

    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      ide,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/reset"));
    assertEquals(await session.loadSession(), null);
    assertEquals(ide.calls.length, 0);

    ide.result = {
      output: okOutput({ result: "ok", session_id: "new" }),
    };
    await d.handle(msg("new topic"));
    assertEquals(ide.calls[0]!.resumeSessionId, undefined);
    assertEquals(await session.loadSession(), "new");
  });
});

Deno.test("Dispatcher keeps prior token when IDE returns empty session_id", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "claude");
    await session.saveSession("kept-token");

    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      ide,
      session,
      log: silentLog(),
    });
    ide.result = { output: okOutput({ result: "ok", session_id: "" }) };
    await d.handle(msg("hello"));
    assertEquals(await session.loadSession(), "kept-token");
  });
});

Deno.test("Dispatcher chunks long IDE output across sendMessage calls", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const ide = new FakeAdapter();
  const big = "line\n".repeat(1500);
  ide.result = { output: okOutput({ result: big, session_id: "s" }) };
  const d = new Dispatcher({ cfg: cfg(), sender, ide, log: silentLog() });
  await d.handle(msg("big"));
  const sends = calls.filter((c) => c.method === "sendMessage");
  assert(sends.length >= 2);
  const concat = sends.map((s) => s.body.text as string).join("");
  assertEquals(concat, big);
});

Deno.test("Dispatcher invokes sendChatAction typing before IDE call", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const ide = new FakeAdapter();
  const d = new Dispatcher({ cfg: cfg(), sender, ide, log: silentLog() });
  await d.handle(msg("hi"));
  const hasTyping = calls.some((c) =>
    c.method === "sendChatAction" && c.body.action === "typing"
  );
  assert(hasTyping, "expected sendChatAction=typing call");
});

Deno.test("Dispatcher /reset replies even without session store", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const d = new Dispatcher({ cfg: cfg(), sender, log: silentLog() });
  await d.handle(msg("/reset"));
  const sends = calls.filter((c) => c.method === "sendMessage");
  assertEquals(sends.length, 1);
  assertEquals(sends[0]!.body.text, "session cleared");
});

Deno.test("Dispatcher streams onEvent through Streamer to TG edits", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const streamer = new Streamer({
    sender,
    clock: {
      now: () => 0,
      setTimeout: (cb) => {
        queueMicrotask(cb);
        return 0;
      },
      clearTimeout: () => {},
    },
    minEditIntervalMs: 0,
  });
  const ide = new FakeAdapter();
  ide.setHandler((opts: RuntimeInvokeOptions) => {
    opts.onEvent?.({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "engine/cli.ts" },
          },
          { type: "text", text: "hello" },
        ],
      },
    });
    return { output: okOutput({ result: "final answer", session_id: "s" }) };
  });
  const d = new Dispatcher({
    cfg: cfg(),
    sender,
    ide,
    streamer,
    log: silentLog(),
  });
  await d.handle(msg("go"));
  const sends = calls.filter((c) => c.method === "sendMessage");
  const edits = calls.filter((c) => c.method === "editMessageText");
  assertEquals(sends.length, 1, "single live message opened");
  assert(edits.length >= 1, "at least one edit with streamed content");
  const finalText = edits.at(-1)!.body.text as string;
  assertStringIncludes(finalText, "🛠️");
  assertStringIncludes(finalText, "<b>Read</b>");
  assertStringIncludes(finalText, "<code>engine/cli.ts</code>");
  assertStringIncludes(finalText, "final answer");
  assert(
    !finalText.includes("💬"),
    `text-block preview must not render: ${finalText}`,
  );
  assert(
    !finalText.includes("hello"),
    `assistant text block content leaked into stream: ${finalText}`,
  );
  assert(!finalText.includes("✓"), `OK marker must not appear: ${finalText}`);
});

Deno.test("Dispatcher finalizes live message with ✗ on IDE error", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const streamer = new Streamer({
    sender,
    clock: {
      now: () => 0,
      setTimeout: (cb) => {
        queueMicrotask(cb);
        return 0;
      },
      clearTimeout: () => {},
    },
    minEditIntervalMs: 0,
  });
  const ide = new FakeAdapter();
  ide.result = { error: "kaboom" };
  const d = new Dispatcher({
    cfg: cfg(),
    sender,
    ide,
    streamer,
    log: silentLog(),
  });
  await d.handle(msg("go"));
  const edits = calls.filter((c) => c.method === "editMessageText");
  const finalText = edits.at(-1)!.body.text as string;
  assertStringIncludes(finalText, "✗");
  assertStringIncludes(finalText, "kaboom");
});

// FR-SETTINGS — TG command surface

Deno.test("Dispatcher /settings prints effective settings", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    await session.saveSettings({ model: "opus" });
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/settings"));
    const text = calls.at(-1)!.body.text as string;
    assertStringIncludes(text, "ide: claude");
    assertStringIncludes(text, "model: opus");
    assertStringIncludes(text, "timeoutSeconds: 600 (default)");
  });
});

Deno.test("Dispatcher /model opus stores setting", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/model opus"));
    assertEquals((await session.loadSettings()).model, "opus");
  });
});

Deno.test("Dispatcher /model with invalid value rejects and preserves state", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    await session.saveSettings({ model: "opus" });
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/model gpt-5"));
    const reply = calls.at(-1)!.body.text as string;
    assertStringIncludes(reply, "invalid model 'gpt-5'");
    assertEquals((await session.loadSettings()).model, "opus");
  });
});

Deno.test("Dispatcher /model clear unsets the field", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    await session.saveSettings({ model: "opus" });
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/model clear"));
    assertEquals((await session.loadSettings()).model, undefined);
  });
});

Deno.test("Dispatcher /model without arg shows current + whitelist", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    await session.saveSettings({ model: "opus" });
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/model"));
    const reply = calls.at(-1)!.body.text as string;
    assertStringIncludes(reply, "model: opus");
    assertStringIncludes(reply, "allowed:");
    assertStringIncludes(reply, "sonnet");
  });
});

Deno.test("Dispatcher /effort on opencode reports not supported", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    const d = new Dispatcher({
      cfg: cfg({ ide: "opencode", project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/effort high"));
    const reply = calls.at(-1)!.body.text as string;
    assertStringIncludes(reply, "not supported");
    assertEquals((await session.loadSettings()).effort, undefined);
  });
});

Deno.test("Dispatcher /timeout 42 stores numeric setting", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/timeout 42"));
    assertEquals((await session.loadSettings()).timeoutSeconds, 42);
  });
});

Deno.test("Dispatcher /timeout 0 is rejected with clear error", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/timeout 0"));
    const reply = calls.at(-1)!.body.text as string;
    assertStringIncludes(reply, "timeoutSeconds");
    assertEquals((await session.loadSettings()).timeoutSeconds, undefined);
  });
});

Deno.test("Dispatcher /retries clear resets to default", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    await session.saveSettings({ maxRetries: 5 });
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/retries clear"));
    assertEquals((await session.loadSettings()).maxRetries, undefined);
  });
});

Deno.test("Dispatcher /retry_delay alias sets retryDelaySeconds", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const session = new SessionStore(dir, "claude");
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/retry_delay 3"));
    assertEquals((await session.loadSettings()).retryDelaySeconds, 3);
  });
});

Deno.test("Dispatcher command changes take effect on next IDE call", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "claude");
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      ide,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/model opus"));
    await d.handle(msg("ping"));
    assertEquals(ide.calls[0]!.model, "opus");
  });
});

Deno.test("Dispatcher /stop replies 'no active IDE call' when idle", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const d = new Dispatcher({ cfg: cfg(), sender, log: silentLog() });
  await d.handle(msg("/stop"));
  assertEquals(calls.at(-1)!.body.text, "no active IDE call");
});

Deno.test("Dispatcher /stop bypasses queue and aborts running invocation via AbortSignal", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const ide = new FakeAdapter();
  let receivedSignal: AbortSignal | undefined;
  ide.invoke = (opts: RuntimeInvokeOptions) => {
    receivedSignal = opts.signal;
    return new Promise((resolve) => {
      opts.signal?.addEventListener("abort", () => {
        resolve({ error: "aborted" });
      });
    });
  };
  const d = new Dispatcher({
    cfg: cfg(),
    sender,
    ide,
    log: silentLog(),
  });
  // Start a long call (do not await yet).
  const running = d.handle(msg("long prompt"));
  // Wait a tick so the dispatcher has entered the invocation.
  await new Promise((r) => setTimeout(r, 10));
  // /stop should execute immediately, not wait for the running call.
  await d.handle(msg("/stop"));
  assert(receivedSignal !== undefined, "expected AbortSignal on invoke opts");
  assert(receivedSignal!.aborted, "expected signal to be aborted");
  const stopReply = calls.find((c) =>
    c.method === "sendMessage" && c.body.text === "IDE call stopped"
  );
  assert(stopReply, "expected 'IDE call stopped' reply");
  await running;
});

Deno.test("Dispatcher does not invoke IDE for recognized commands", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "claude");
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      ide,
      session,
      log: silentLog(),
    });
    await d.handle(msg("/settings"));
    await d.handle(msg("/model opus"));
    await d.handle(msg("/timeout 10"));
    assertEquals(ide.calls.length, 0);
  });
});

// FR-CAPABILITY-INVENTORY

import type {
  CapabilityProvider,
  CapabilityRegistry,
  RefreshResult,
} from "./capabilities.ts";

class FakeProvider implements CapabilityProvider {
  registry: CapabilityRegistry | null;
  refreshes = 0;
  refreshError: Error | null = null;
  nextResult: RefreshResult = { entries: 0, skipped: [] };
  constructor(initial: CapabilityRegistry | null = null) {
    this.registry = initial;
  }
  current(): CapabilityRegistry | null {
    return this.registry;
  }
  refresh(): Promise<RefreshResult> {
    this.refreshes++;
    if (this.refreshError) return Promise.reject(this.refreshError);
    return Promise.resolve(this.nextResult);
  }
}

Deno.test("Dispatcher /refresh replies 'not supported' when ide lacks inventory", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const ide = new FakeAdapter(); // capabilityInventory: false
  const provider = new FakeProvider();
  const d = new Dispatcher({
    cfg: cfg(),
    sender,
    ide,
    capabilities: provider,
    log: silentLog(),
  });
  await d.handle(msg("/refresh"));
  const text = calls.at(-1)!.body.text as string;
  assertStringIncludes(text, "not supported");
  assertEquals(provider.refreshes, 0);
});

Deno.test("Dispatcher /refresh runs provider.refresh when supported and replies summary", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const ide = new FakeAdapter();
  ide.capabilities = { ...ide.capabilities, capabilityInventory: true };
  const provider = new FakeProvider();
  provider.nextResult = {
    entries: 5,
    skipped: [
      { name: "stop", reason: "reserved" },
      { name: "x.y", reason: "duplicate" },
    ],
  };
  const d = new Dispatcher({
    cfg: cfg(),
    sender,
    ide,
    capabilities: provider,
    log: silentLog(),
  });
  await d.handle(msg("/refresh"));
  assertEquals(provider.refreshes, 1);
  const sends = calls.filter((c) => c.method === "sendMessage").map((c) =>
    c.body.text as string
  );
  assertStringIncludes(sends.at(0)!, "discovering");
  const summary = sends.at(-1)!;
  assertStringIncludes(summary, "discovered 5");
  assertStringIncludes(summary, "skipped 2");
  assertStringIncludes(summary, "reserved=1");
  assertStringIncludes(summary, "duplicate=1");
});

Deno.test("Dispatcher /refresh reports error trailer on failure", async () => {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("t", { fetchFn });
  const ide = new FakeAdapter();
  ide.capabilities = { ...ide.capabilities, capabilityInventory: true };
  const provider = new FakeProvider();
  provider.refreshError = new Error("kaboom");
  const d = new Dispatcher({
    cfg: cfg(),
    sender,
    ide,
    capabilities: provider,
    log: silentLog(),
  });
  await d.handle(msg("/refresh"));
  const text = calls.at(-1)!.body.text as string;
  assertStringIncludes(text, "✗ refresh failed");
  assertStringIncludes(text, "kaboom");
});

Deno.test("Dispatcher rewrites discovered TG name to original IDE name", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "claude");
    const provider = new FakeProvider({
      runtime: "claude",
      fetchedAt: "2026-04-25T00:00:00Z",
      entries: [
        {
          tgName: "flowai_skill_x",
          originalName: "flowai-skill-x",
          kind: "skill",
          description: "skill",
        },
      ],
    });
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      ide,
      session,
      capabilities: provider,
      log: silentLog(),
    });
    await d.handle(msg("/flowai_skill_x arg1 arg2"));
    assertEquals(ide.calls.length, 1);
    assertEquals(ide.calls[0]!.taskPrompt, "/flowai-skill-x arg1 arg2");
  });
});

Deno.test("Dispatcher forwards unknown /<cmd> verbatim when not in registry", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const ide = new FakeAdapter();
    const session = new SessionStore(dir, "claude");
    const provider = new FakeProvider(null);
    const d = new Dispatcher({
      cfg: cfg({ project_dir: dir }),
      sender,
      ide,
      session,
      capabilities: provider,
      log: silentLog(),
    });
    await d.handle(msg("/unknown foo"));
    assertEquals(ide.calls.length, 1);
    assertEquals(ide.calls[0]!.taskPrompt, "/unknown foo");
  });
});
