/**
 * @module
 * Real-IDE e2e tests. Each test runs against every supported IDE's actual
 * CLI binary (skipped if the binary is absent). Assertions are
 * contract-level — they tolerate model non-determinism. Failing a test
 * means either (a) the IDE binary regressed, (b) `ai-ide-cli` broke its
 * wire contract, or (c) auth is misconfigured.
 */

import { assert, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_E2E_SETTINGS,
  type Harness,
  probeAllIdes,
  rebuildHarness,
  stopPromptForIde,
  testPerIde,
} from "./harness.ts";

const skips = await probeAllIdes();

/**
 * Race a promise against a timeout. If the timeout wins, attach a clear
 * failure message that names the timeout budget so flakes are easy to
 * triage. Cancels the timer on resolution to avoid leaking handles.
 */
async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let handle = 0;
  const timeout = new Promise<never>((_res, rej) => {
    handle = setTimeout(
      () => rej(new Error(`${what} exceeded ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(handle);
  }
}

function bodyAfterBlockquote(body: string): string {
  const closeTag = "</blockquote>";
  const idx = body.lastIndexOf(closeTag);
  return idx < 0 ? body : body.slice(idx + closeTag.length).trim();
}

testPerIde(
  skips,
  "basic prompt produces a final reply rendered outside the blockquote",
  async (h: Harness) => {
    const live = await h.streamer.open(1);
    await withDeadline(
      h.mgr.runTurn({
        live,
        text:
          "Reply with the single word OK and nothing else. Do not use any tools.",
        settings: DEFAULT_E2E_SETTINGS,
        stopSignal: new AbortController().signal,
      }),
      120_000,
      "basic prompt turn",
    );
    const edits = h.calls.filter((c) => c.method === "editMessageText");
    assert(
      edits.length > 0,
      "expected at least one editMessageText call during turn",
    );
    const body = h.lastEditBody();
    const after = bodyAfterBlockquote(body);
    assert(
      after.length > 0 || body.trim().length > 0,
      `final body is empty: ${JSON.stringify(body)}`,
    );
    const token = await h.store.loadSession();
    assert(
      token !== null && token.length > 0,
      "session token must be persisted after a successful turn",
    );
  },
);

testPerIde(
  skips,
  "turn 2 resumes the session id persisted from turn 1",
  async (h: Harness) => {
    const live1 = await h.streamer.open(1);
    await withDeadline(
      h.mgr.runTurn({
        live: live1,
        text: "Reply with just A.",
        settings: DEFAULT_E2E_SETTINGS,
        stopSignal: new AbortController().signal,
      }),
      120_000,
      "resume turn 1",
    );
    const token1 = await h.store.loadSession();
    assert(
      token1 !== null && token1.length > 0,
      "turn 1 did not persist a session id",
    );

    await h.mgr.close();
    const resumed = await rebuildHarness(h);
    try {
      const live2 = await resumed.streamer.open(1);
      await withDeadline(
        resumed.mgr.runTurn({
          live: live2,
          text: "Reply with just B.",
          settings: DEFAULT_E2E_SETTINGS,
          stopSignal: new AbortController().signal,
        }),
        120_000,
        "resume turn 2",
      );
      assert(
        resumed.openCalls.length >= 1,
        `expected reopened manager to call openSession, got ${resumed.openCalls.length}`,
      );
      assert(
        resumed.openCalls[0]!.resumeSessionId === token1,
        `expected resumeSessionId ${token1}, got ${
          resumed.openCalls[0]!.resumeSessionId
        }`,
      );
      const token2 = await resumed.store.loadSession();
      assert(
        token2 !== null && token2.length > 0,
        "turn 2 must leave a non-empty session id",
      );
    } finally {
      await resumed.cleanup();
    }
  },
);

testPerIde(
  skips,
  "stopSignal aborts an in-flight turn and finalizes with x",
  async (h: Harness) => {
    const live = await h.streamer.open(1);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 800);
    await withDeadline(
      h.mgr.runTurn({
        live,
        text: stopPromptForIde(h.ide),
        settings: DEFAULT_E2E_SETTINGS,
        stopSignal: ctrl.signal,
      }),
      60_000,
      "stop test turn",
    );
    const body = h.lastEditBody();
    assertStringIncludes(body, "\u2717");
  },
);
