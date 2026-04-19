/**
 * @module
 * Telegram `sendMessage` / `sendChatAction` client. Owns the FR-RESPONSE-STREAM
 * chunking algorithm: split long IDE output into ≤4000-char messages, prefer
 * newline boundaries, never truncate silently.
 *
 * All outbound strings (including thrown errors) run through `sanitizeError`
 * so the bot token cannot leak via an error log.
 */

import { sanitizeError } from "../log.ts";

export const CHUNK_LIMIT = 4000;

/**
 * Pure chunker. Splits `text` into pieces of at most `CHUNK_LIMIT` characters,
 * preferring to cut at the last `\n` within the limit. Falls back to a hard
 * cut when no newline is available in the current window. The concatenation
 * of all returned chunks equals the input — lossless by contract.
 */
// FR-RESPONSE-STREAM
export function chunkText(text: string): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const remaining = text.length - i;
    if (remaining <= CHUNK_LIMIT) {
      chunks.push(text.slice(i));
      break;
    }
    const window = text.slice(i, i + CHUNK_LIMIT);
    const nl = window.lastIndexOf("\n");
    // Keep newline with the preceding chunk so boundaries stay readable.
    const cut = nl >= 0 ? nl + 1 : CHUNK_LIMIT;
    chunks.push(text.slice(i, i + cut));
    i += cut;
  }
  return chunks;
}

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export interface SenderOptions {
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  maxRetries?: number;
  baseDelayMs?: number;
}

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export class Sender {
  readonly #token: string;
  readonly #fetch: FetchFn;
  readonly #sleep: SleepFn;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;

  constructor(token: string, opts: SenderOptions = {}) {
    this.#token = token;
    this.#fetch = opts.fetchFn ?? fetch;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#baseDelayMs = opts.baseDelayMs ?? 1000;
  }

  #url(method: string): string {
    return `https://api.telegram.org/bot${this.#token}/${method}`;
  }

  async #post(
    method: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        const res = await this.#fetch(this.#url(method), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Telegram ${method} HTTP ${res.status}: ${sanitizeError(text)}`,
          );
        }
        const json = (await res.json()) as {
          ok: boolean;
          description?: string;
          result?: unknown;
        };
        if (!json.ok) {
          throw new Error(
            `Telegram ${method} error: ${
              sanitizeError(json.description ?? "")
            }`,
          );
        }
        return json.result;
      } catch (err) {
        lastErr = err;
        if (attempt === this.#maxRetries) break;
        await this.#sleep(this.#baseDelayMs * Math.pow(2, attempt));
      }
    }
    throw new Error(sanitizeError(lastErr));
  }

  async send(
    chatId: number,
    text: string,
    threadId?: number,
    opts?: { parseMode?: string },
  ): Promise<{ messageId: number }> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (threadId !== undefined) body.message_thread_id = threadId;
    if (opts?.parseMode) body.parse_mode = opts.parseMode;
    const result = await this.#post("sendMessage", body) as
      | { message_id?: number }
      | undefined;
    const id = result?.message_id;
    if (typeof id !== "number") {
      throw new Error(
        `Telegram sendMessage returned no message_id: ${
          sanitizeError(JSON.stringify(result ?? null))
        }`,
      );
    }
    return { messageId: id };
  }

  /** Edit the text of a previously sent message. Used by the live-stream Streamer. */
  // FR-EVENT-STREAM
  async edit(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { parseMode?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (opts?.parseMode) body.parse_mode = opts.parseMode;
    await this.#post("editMessageText", body);
  }

  async sendChatAction(
    chatId: number,
    action: "typing",
    threadId?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, action };
    if (threadId !== undefined) body.message_thread_id = threadId;
    await this.#post("sendChatAction", body);
  }

  /**
   * Register the bot's slash-command menu shown in Telegram clients. Idempotent —
   * Telegram replaces the full list on each call. Command names must match
   * `^[a-z0-9_]{1,32}$`; descriptions ≤ 256 chars.
   */
  async setMyCommands(
    commands: ReadonlyArray<{ command: string; description: string }>,
  ): Promise<void> {
    await this.#post("setMyCommands", { commands });
  }

  /** Perform a one-shot `getMe` health check. Throws on failure. */
  async getMe(): Promise<{ id: number; username?: string }> {
    const res = await this.#fetch(this.#url("getMe"));
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Telegram getMe HTTP ${res.status}: ${sanitizeError(text)}`,
      );
    }
    const json = (await res.json()) as {
      ok: boolean;
      result?: { id: number; username?: string };
      description?: string;
    };
    if (!json.ok || !json.result) {
      throw new Error(
        `Telegram getMe rejected: ${sanitizeError(json.description ?? "")}`,
      );
    }
    return json.result;
  }
}
