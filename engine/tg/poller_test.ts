import { assert, assertEquals } from "@std/assert";
import { Poller } from "./poller.ts";
import type { TgUpdate } from "./types.ts";

interface Call {
  url: string;
  offset: number;
}

function scriptedFetch(
  script: Array<
    | { kind: "ok"; updates: TgUpdate[] }
    | { kind: "err"; message: string }
  >,
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let idx = 0;
  const fetchFn = (async (
    input: Request | URL | string,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const m = url.match(/offset=(-?\d+)/);
    const offset = m ? Number(m[1]) : 0;
    calls.push({ url, offset });
    const step = script[idx++];
    if (!step) {
      // After script exhausted, return an empty list forever.
      return await Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
      );
    }
    if (step.kind === "ok") {
      return await Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: step.updates }), {
          status: 200,
        }),
      );
    }
    throw new Error(step.message);
  }) as typeof fetch;
  return { fetchFn, calls };
}

Deno.test("Poller yields updates and advances offset", async () => {
  const { fetchFn, calls } = scriptedFetch([
    {
      kind: "ok",
      updates: [
        {
          update_id: 5,
          message: { message_id: 1, chat: { id: 1 }, text: "a" },
        },
        {
          update_id: 9,
          message: { message_id: 2, chat: { id: 1 }, text: "b" },
        },
      ],
    },
    { kind: "ok", updates: [] },
  ]);
  const controller = new AbortController();
  const poller = new Poller("t", { fetchFn, sleep: () => Promise.resolve() });
  const collected: TgUpdate[] = [];
  const iter = poller.poll(controller.signal);
  for await (const u of iter) {
    collected.push(u);
    if (collected.length === 2) {
      controller.abort();
      break;
    }
  }
  assertEquals(collected.map((u) => u.update_id), [5, 9]);
  assertEquals(calls[0]!.offset, 0);
});

Deno.test("Poller advances offset across loop iterations", async () => {
  const { fetchFn, calls } = scriptedFetch([
    {
      kind: "ok",
      updates: [
        {
          update_id: 7,
          message: { message_id: 1, chat: { id: 1 }, text: "x" },
        },
      ],
    },
    { kind: "ok", updates: [] },
  ]);
  const controller = new AbortController();
  // Abort after the second fetch so the loop exits promptly.
  const wrapped: typeof fetch = async (input, init) => {
    const res = await fetchFn(input, init);
    if (calls.length >= 2) controller.abort();
    return res;
  };
  const poller = new Poller("t", {
    fetchFn: wrapped,
    sleep: () => Promise.resolve(),
  });
  let count = 0;
  for await (const _ of poller.poll(controller.signal)) {
    count++;
  }
  assertEquals(count, 1);
  assertEquals(calls[0]!.offset, 0);
  assertEquals(calls[1]!.offset, 8);
});

Deno.test("Poller backs off exponentially on network error", async () => {
  const { fetchFn } = scriptedFetch([
    { kind: "err", message: "boom" },
    { kind: "err", message: "boom" },
    { kind: "err", message: "boom" },
    { kind: "ok", updates: [] },
  ]);
  const sleeps: number[] = [];
  const controller = new AbortController();
  const poller = new Poller("t", {
    fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= 3) controller.abort();
      return Promise.resolve();
    },
  });
  const iter = poller.poll(controller.signal);
  for await (const _ of iter) { /* never yields */ }
  assertEquals(sleeps.slice(0, 3), [1000, 2000, 4000]);
});

Deno.test("Poller caps backoff at 30s", async () => {
  const errs: Array<{ kind: "err"; message: string }> = Array.from(
    { length: 20 },
    () => ({ kind: "err" as const, message: "boom" }),
  );
  const { fetchFn } = scriptedFetch(errs);
  const sleeps: number[] = [];
  const controller = new AbortController();
  const poller = new Poller("t", {
    fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= 10) controller.abort();
      return Promise.resolve();
    },
  });
  for await (const _ of poller.poll(controller.signal)) { /* nothing */ }
  for (const s of sleeps) assert(s <= 30_000);
  assertEquals(sleeps.at(-1), 30_000);
});

Deno.test("Poller stops on abort signal before fetching", async () => {
  const { fetchFn, calls } = scriptedFetch([]);
  const controller = new AbortController();
  controller.abort();
  const poller = new Poller("t", { fetchFn, sleep: () => Promise.resolve() });
  for await (const _ of poller.poll(controller.signal)) {
    throw new Error("should not yield");
  }
  assertEquals(calls.length, 0);
});
