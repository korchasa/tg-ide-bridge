/**
 * @module
 * Telegram long-polling loop (FR-TG-POLL). Tracks `offset`, yields each
 * update as an async iterator, and retries transient network / API errors
 * with exponential backoff capped at 30 s.
 *
 * The loop exits cleanly when `AbortSignal` is aborted.
 */

import { sanitizeError } from "../log.ts";
import type { TgResponse, TgUpdate } from "./types.ts";

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export interface PollerOptions {
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  longPollSeconds?: number;
  onError?: (err: string) => void;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export class Poller {
  readonly #token: string;
  readonly #fetch: FetchFn;
  readonly #sleep: SleepFn;
  readonly #timeout: number;
  readonly #onError: (err: string) => void;

  constructor(token: string, opts: PollerOptions = {}) {
    this.#token = token;
    this.#fetch = opts.fetchFn ?? fetch;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#timeout = opts.longPollSeconds ?? 25;
    this.#onError = opts.onError ?? (() => {});
  }

  // FR-TG-POLL
  async *poll(signal: AbortSignal): AsyncIterable<TgUpdate> {
    let offset = 0;
    let failureCount = 0;
    while (!signal.aborted) {
      const url = `https://api.telegram.org/bot${this.#token}/getUpdates` +
        `?offset=${offset}&timeout=${this.#timeout}` +
        `&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`;
      try {
        const res = await this.#fetch(url, { signal });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const json = (await res.json()) as TgResponse<TgUpdate[]>;
        if (!json.ok) {
          throw new Error(`getUpdates rejected: ${json.description ?? ""}`);
        }
        failureCount = 0;
        const updates = json.result ?? [];
        for (const u of updates) {
          if (signal.aborted) return;
          yield u;
          if (u.update_id + 1 > offset) offset = u.update_id + 1;
        }
      } catch (err) {
        if (signal.aborted) return;
        this.#onError(sanitizeError(err));
        // FR-TG-POLL: exponential backoff capped at 30 s on transient errors.
        const delay = Math.min(
          BASE_BACKOFF_MS * Math.pow(2, failureCount),
          MAX_BACKOFF_MS,
        );
        failureCount++;
        await this.#sleep(delay);
      }
    }
  }
}
