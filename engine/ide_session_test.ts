import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SessionManager } from "./ide_session.ts";
import { SessionStore } from "./session.ts";
import { Streamer } from "./tg/streamer.ts";
import { Sender } from "./tg/sender.ts";
import { fakeFetch } from "./tg/sender_test_util.ts";
import { createLogger } from "./log.ts";
import {
  type RuntimeAdapter,
  type RuntimeSession,
  type RuntimeSessionEvent,
  type RuntimeSessionOptions,
  type RuntimeSessionStatus,
  SYNTHETIC_TURN_END,
} from "@korchasa/ai-ide-cli";

function silentLog() {
  return createLogger(() => {});
}

function noDelayClock() {
  return {
    now: () => 0,
    setTimeout: (cb: () => void) => {
      queueMicrotask(cb);
      return 0;
    },
    clearTimeout: () => {},
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Programmable in-memory RuntimeSession for tests. */
class FakeSession implements RuntimeSession {
  readonly runtime = "claude" as const;
  #sessionId: string;
  readonly #doneDeferred = Promise.withResolvers<RuntimeSessionStatus>();
  readonly #events: Array<RuntimeSessionEvent> = [];
  #waiter: (() => void) | null = null;
  #closed = false;
  sent: string[] = [];
  opts: RuntimeSessionOptions;
  abortReason: string | undefined;

  constructor(opts: RuntimeSessionOptions, initialId = "sess-init") {
    this.opts = opts;
    this.#sessionId = opts.resumeSessionId ?? initialId;
    opts.signal?.addEventListener("abort", () => {
      this.abort("external-signal");
    });
  }

  get sessionId(): string {
    return this.#sessionId;
  }
  setSessionId(id: string): void {
    this.#sessionId = id;
  }

  send(content: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("closed"));
    this.sent.push(content);
    return Promise.resolve();
  }

  endInput(): Promise<void> {
    return Promise.resolve();
  }

  abort(reason?: string): void {
    if (this.#closed) return;
    this.abortReason = reason;
    this.#closed = true;
    this.#waiter?.();
    this.#waiter = null;
    this.#doneDeferred.resolve({ exitCode: 0, signal: "SIGTERM", stderr: "" });
  }

  get done(): Promise<RuntimeSessionStatus> {
    return this.#doneDeferred.promise;
  }

  pushEvent(ev: RuntimeSessionEvent): void {
    this.#events.push(ev);
    this.#waiter?.();
    this.#waiter = null;
  }

  emitStderr(chunk: string): void {
    this.opts.onStderr?.(chunk);
  }

  emitTurnEnd(raw: Record<string, unknown>): void {
    this.pushEvent({
      runtime: "claude",
      type: SYNTHETIC_TURN_END,
      raw,
      synthetic: true,
    });
  }

  get events(): AsyncIterable<RuntimeSessionEvent> {
    return { [Symbol.asyncIterator]: () => this.#iterate() };
  }

  async *#iterate(): AsyncGenerator<RuntimeSessionEvent> {
    while (true) {
      if (this.#events.length > 0) {
        yield this.#events.shift()!;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((r) => {
        this.#waiter = r;
      });
    }
  }
}

class FakeSessionAdapter implements RuntimeAdapter {
  id = "claude" as const;
  capabilities = {
    permissionMode: true,
    hitl: false,
    transcript: false,
    interactive: true,
    toolUseObservation: false,
    session: true,
    capabilityInventory: false,
    toolFilter: false,
    reasoningEffort: false,
  };
  openedSessions: FakeSession[] = [];
  nextInitialId = "sess-init";

  invoke(): Promise<never> {
    return Promise.reject(new Error("invoke not used in session-mode tests"));
  }
  launchInteractive(): Promise<{ exitCode: number }> {
    return Promise.resolve({ exitCode: 0 });
  }
  openSession(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    const s = new FakeSession(opts, this.nextInitialId);
    this.openedSessions.push(s);
    return Promise.resolve(s);
  }
  lastSession(): FakeSession {
    return this.openedSessions[this.openedSessions.length - 1]!;
  }
}

function defaultSettings() {
  return {
    timeoutSeconds: 600,
    maxRetries: 1,
    retryDelaySeconds: 2,
  };
}

Deno.test("SessionManager opens session on first turn and reuses it on next turn", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const store = new SessionStore(dir, "claude");
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      store,
      log: silentLog(),
    });

    const live1 = await streamer.open(1);
    const turn1 = mgr.runTurn({
      live: live1,
      text: "first",
      settings: defaultSettings(),
      stopSignal: new AbortController().signal,
    });
    // Wait for event drain to start consuming.
    await new Promise((r) => setTimeout(r, 5));
    const sess = ide.lastSession();
    assertEquals(sess.sent, ["first"]);
    sess.emitTurnEnd({
      type: "result",
      is_error: false,
      result: "hello-from-ide",
      session_id: "sess-fresh",
    });
    await turn1;

    // Second turn reuses the same session.
    const live2 = await streamer.open(1);
    const turn2 = mgr.runTurn({
      live: live2,
      text: "second",
      settings: defaultSettings(),
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(ide.openedSessions.length, 1, "session reused");
    assertEquals(sess.sent, ["first", "second"]);
    sess.emitTurnEnd({ type: "result", is_error: false, result: "second-out" });
    await turn2;

    await mgr.close();
  });
});

Deno.test("SessionManager persists session id from turn-end payload", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const store = new SessionStore(dir, "claude");
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      store,
      log: silentLog(),
    });

    const live = await streamer.open(1);
    const turn = mgr.runTurn({
      live,
      text: "go",
      settings: defaultSettings(),
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ide.lastSession();
    sess.setSessionId("captured-id");
    sess.emitTurnEnd({ type: "result", is_error: false, result: "done" });
    await turn;
    await mgr.close();
    assertEquals(await store.loadSession(), "captured-id");
  });
});

Deno.test("SessionManager passes stored id as resumeSessionId on open", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const store = new SessionStore(dir, "claude");
    await store.saveSession("prior-id");
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      store,
      log: silentLog(),
    });

    const live = await streamer.open(1);
    const turn = mgr.runTurn({
      live,
      text: "continue",
      settings: defaultSettings(),
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ide.lastSession();
    assertEquals(sess.opts.resumeSessionId, "prior-id");
    sess.emitTurnEnd({ type: "result", is_error: false, result: "ok" });
    await turn;
    await mgr.close();
  });
});

Deno.test("SessionManager reopens session when model changes", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const store = new SessionStore(dir, "claude");
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      store,
      log: silentLog(),
    });

    const live1 = await streamer.open(1);
    const turn1 = mgr.runTurn({
      live: live1,
      text: "first",
      settings: { ...defaultSettings(), model: "sonnet" },
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    ide.lastSession().setSessionId("first-id");
    ide.lastSession().emitTurnEnd({
      type: "result",
      is_error: false,
      result: "a",
    });
    await turn1;

    const live2 = await streamer.open(1);
    const turn2 = mgr.runTurn({
      live: live2,
      text: "second",
      settings: { ...defaultSettings(), model: "opus" },
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(
      ide.openedSessions.length,
      2,
      "session reopened on model change",
    );
    const reopened = ide.lastSession();
    assertEquals(
      reopened.opts.resumeSessionId,
      "first-id",
      "reopened session resumes conversation",
    );
    assertEquals(reopened.opts.model, "opus");
    reopened.emitTurnEnd({ type: "result", is_error: false, result: "b" });
    await turn2;
    await mgr.close();
  });
});

Deno.test("SessionManager aborts session when stopSignal fires", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      log: silentLog(),
    });

    const live = await streamer.open(1);
    const stop = new AbortController();
    const turn = mgr.runTurn({
      live,
      text: "loop",
      settings: defaultSettings(),
      stopSignal: stop.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    stop.abort("stopped by user");
    await turn;
    const edits = calls.filter((c) => c.method === "editMessageText");
    const finalText = edits.at(-1)!.body.text as string;
    assertStringIncludes(finalText, "✗");
    assertStringIncludes(finalText, "stopped by user");
    assert(!mgr.hasActiveSession, "session should be closed after abort");
    await mgr.close();
  });
});

Deno.test("SessionManager reset() clears persisted id so next session opens fresh", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const store = new SessionStore(dir, "claude");
    await store.saveSession("old-id");
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      store,
      log: silentLog(),
    });

    await mgr.reset();
    const live = await streamer.open(1);
    const turn = mgr.runTurn({
      live,
      text: "after-reset",
      settings: defaultSettings(),
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(
      ide.lastSession().opts.resumeSessionId,
      undefined,
      "no resume id after reset",
    );
    ide.lastSession().emitTurnEnd({
      type: "result",
      is_error: false,
      result: "x",
    });
    await turn;
    await mgr.close();
  });
});

Deno.test("SessionManager routes assistant events to live handle and renders final text", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      log: silentLog(),
    });

    const live = await streamer.open(1);
    const turn = mgr.runTurn({
      live,
      text: "hi",
      settings: defaultSettings(),
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ide.lastSession();
    sess.pushEvent({
      runtime: "claude",
      type: "assistant",
      raw: {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "engine/cli.ts" },
            },
          ],
        },
      },
    });
    sess.emitTurnEnd({
      type: "result",
      is_error: false,
      result: "final answer",
    });
    await turn;
    const edits = calls.filter((c) => c.method === "editMessageText");
    const finalText = edits.at(-1)!.body.text as string;
    assertStringIncludes(finalText, "<b>Read</b>");
    assertStringIncludes(finalText, "<code>engine/cli.ts</code>");
    assertStringIncludes(finalText, "final answer");
    await mgr.close();
  });
});

Deno.test("SessionManager surfaces is_error=true as finalize('error')", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      log: silentLog(),
    });

    const live = await streamer.open(1);
    const turn = mgr.runTurn({
      live,
      text: "bad",
      settings: defaultSettings(),
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    ide.lastSession().emitTurnEnd({
      type: "result",
      is_error: true,
      result: "model refused",
    });
    await turn;
    const edits = calls.filter((c) => c.method === "editMessageText");
    const finalText = edits.at(-1)!.body.text as string;
    assertStringIncludes(finalText, "✗");
    assertStringIncludes(finalText, "model refused");
    await mgr.close();
  });
});

Deno.test("SessionManager extracts final text from codex item/completed agentMessage", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const mgr = new SessionManager({
      ide,
      ideId: "codex",
      cwd: dir,
      log: silentLog(),
    });

    const live = await streamer.open(1);
    const turn = mgr.runTurn({
      live,
      text: "ping",
      settings: defaultSettings(),
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ide.lastSession();
    // Codex app-server v2 item/completed for an agentMessage carries full
    // text as `item.text` (camelCase types from `codex app-server
    // generate-ts`).
    sess.pushEvent({
      runtime: "codex",
      type: "completed",
      raw: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "codex reply",
          },
        },
      },
    });
    // Codex turn/completed synthetic — no `result` field.
    sess.emitTurnEnd({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    await turn;
    const edits = calls.filter((c) => c.method === "editMessageText");
    const finalText = edits.at(-1)!.body.text as string;
    assertStringIncludes(finalText, "codex reply");
    await mgr.close();
  });
});

Deno.test("SessionManager falls back to assistant text when turn-end raw has no result", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn, calls } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      log: silentLog(),
    });

    const live = await streamer.open(1);
    const turn = mgr.runTurn({
      live,
      text: "hi",
      settings: defaultSettings(),
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ide.lastSession();
    sess.pushEvent({
      runtime: "claude",
      type: "assistant",
      raw: {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "assembled reply" },
          ],
        },
      },
    });
    // Turn-end payload without `result` (e.g. non-Claude runtime shape).
    sess.emitTurnEnd({ type: "session.idle" });
    await turn;
    const edits = calls.filter((c) => c.method === "editMessageText");
    const finalText = edits.at(-1)!.body.text as string;
    assertStringIncludes(finalText, "assembled reply");
    await mgr.close();
  });
});

Deno.test("SessionManager passes typed reasoningEffort for codex on openSession", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const mgr = new SessionManager({
      ide,
      ideId: "codex",
      cwd: dir,
      log: silentLog(),
    });

    const live = await streamer.open(1);
    const turn = mgr.runTurn({
      live,
      text: "ping",
      settings: { ...defaultSettings(), effort: "high" },
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ide.lastSession();
    assertEquals(sess.opts.reasoningEffort, "high");
    assertEquals(sess.opts.extraArgs, undefined);
    sess.emitTurnEnd({ type: "turn/completed" });
    await turn;
    await mgr.close();
  });
});

Deno.test("SessionManager keeps --effort extraArgs for claude on openSession", async () => {
  await withTempDir(async (dir) => {
    const { fetchFn } = fakeFetch();
    const sender = new Sender("t", { fetchFn });
    const streamer = new Streamer({
      sender,
      clock: noDelayClock(),
      minEditIntervalMs: 0,
    });
    const ide = new FakeSessionAdapter();
    const mgr = new SessionManager({
      ide,
      ideId: "claude",
      cwd: dir,
      log: silentLog(),
    });

    const live = await streamer.open(1);
    const turn = mgr.runTurn({
      live,
      text: "ping",
      settings: { ...defaultSettings(), effort: "xhigh" },
      stopSignal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ide.lastSession();
    assertEquals(sess.opts.extraArgs, { "--effort": "xhigh" });
    assertEquals(sess.opts.reasoningEffort, undefined);
    sess.emitTurnEnd({ type: "result", is_error: false, result: "ok" });
    await turn;
    await mgr.close();
  });
});
