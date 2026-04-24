/**
 * @module
 * Shared test helper: a `fetch`-shaped stub that records every Bot API call
 * and returns canned success responses. Used by both unit tests (under
 * `engine/`) and the real-IDE e2e suite (under `e2e/`).
 *
 * File suffix `_test_util.ts` (not `_test.ts`) so `deno test` does not pick
 * it up as a test module.
 */

export interface RecordedCall {
  method: string;
  body: Record<string, unknown>;
}

export interface FakeFetch {
  fetchFn: typeof fetch;
  calls: Array<RecordedCall>;
}

export function fakeFetch(): FakeFetch {
  const calls: Array<RecordedCall> = [];
  let nextMessageId = 1;
  const fetchFn = ((
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = url.split("/").pop() ?? "";
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    calls.push({ method, body });
    const payload: Record<string, unknown> = { ok: true };
    if (method === "sendMessage") {
      payload.result = { message_id: nextMessageId++ };
    }
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200 }),
    );
  }) as typeof fetch;
  return { fetchFn, calls };
}
