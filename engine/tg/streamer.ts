/**
 * @module
 * Live-edit TG message streamer (FR-EVENT-STREAM).
 *
 * Maintains a single TG message edited in place as IDE events arrive, with a
 * debounced flush (≤1 edit/sec per chat) and a rollover before hitting the
 * 4096-char limit. Silent UX (edits do not push notifications) + unbounded
 * effective length via chained messages.
 *
 * Rendering uses Bot API `parse_mode: "HTML"`. Stream events go inside a
 * `<blockquote expandable>…</blockquote>` (collapsible in TG clients); the
 * final assistant result is appended underneath as plain escaped text.
 */

import type { Sender } from "./sender.ts";

/** Injectable clock so tests can advance time deterministically. */
export interface StreamerClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const realClock: StreamerClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export interface StreamerOptions {
  sender: Sender;
  clock?: StreamerClock;
  /** Minimum ms between edits to one chat (TG limit ≈ 1/sec per chat). */
  minEditIntervalMs?: number;
  /** Finalize current message and open a new one when rendered length > this. */
  rolloverAt?: number;
  /** Initial placeholder text for a freshly opened live message. */
  placeholder?: string;
}

const DEFAULT_MIN_EDIT_MS = 1000;
// TG hard limit is 4096; leave headroom for terminal marker + safety.
const DEFAULT_ROLLOVER_AT = 3800;
const DEFAULT_PLACEHOLDER = "…";
const PARSE_MODE = "HTML";
const BQ_OPEN = "<blockquote expandable>";
const BQ_CLOSE = "</blockquote>";
const TAG_OVERHEAD = BQ_OPEN.length + BQ_CLOSE.length;
const ROLLOVER_MARKER = "\n…";
const OK_MARKER = "\n\n<b>✓</b>";
const ERR_PREFIX = "\n\n<b>✗</b> ";
const STREAM_PREFIX_RE = /^\[stream\](?:\s+|$)/;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripStreamPrefix(line: string): string {
  return line.replace(STREAM_PREFIX_RE, "");
}

export class Streamer {
  readonly #sender: Sender;
  readonly #clock: StreamerClock;
  readonly #minEditMs: number;
  readonly #rolloverAt: number;
  readonly #placeholder: string;

  constructor(opts: StreamerOptions) {
    this.#sender = opts.sender;
    this.#clock = opts.clock ?? realClock;
    this.#minEditMs = opts.minEditIntervalMs ?? DEFAULT_MIN_EDIT_MS;
    this.#rolloverAt = opts.rolloverAt ?? DEFAULT_ROLLOVER_AT;
    this.#placeholder = opts.placeholder ?? DEFAULT_PLACEHOLDER;
  }

  async open(chatId: number, threadId?: number): Promise<LiveHandle> {
    const { messageId } = await this.#sender.send(
      chatId,
      this.#placeholder,
      threadId,
      { parseMode: PARSE_MODE },
    );
    return new LiveHandle({
      sender: this.#sender,
      clock: this.#clock,
      minEditMs: this.#minEditMs,
      rolloverAt: this.#rolloverAt,
      placeholder: this.#placeholder,
      chatId,
      threadId,
      messageId,
    });
  }
}

interface HandleDeps {
  sender: Sender;
  clock: StreamerClock;
  minEditMs: number;
  rolloverAt: number;
  placeholder: string;
  chatId: number;
  threadId?: number;
  messageId: number;
}

export class LiveHandle {
  readonly #sender: Sender;
  readonly #clock: StreamerClock;
  readonly #minEditMs: number;
  readonly #rolloverAt: number;
  readonly #placeholder: string;
  readonly #chatId: number;
  readonly #threadId: number | undefined;
  #messageId: number;
  #streamBuffer = "";
  #finalBuffer = "";
  #lastSentText = "";
  #lastFlushAt = 0;
  #flushTimer: number | undefined;
  #flushing: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(deps: HandleDeps) {
    this.#sender = deps.sender;
    this.#clock = deps.clock;
    this.#minEditMs = deps.minEditMs;
    this.#rolloverAt = deps.rolloverAt;
    this.#placeholder = deps.placeholder;
    this.#chatId = deps.chatId;
    this.#threadId = deps.threadId;
    this.#messageId = deps.messageId;
  }

  /** Append a pre-formatted line (from `ai-ide-cli`'s `onOutput`). */
  appendOutput(line: string): void {
    if (this.#closed) return;
    const stripped = stripStreamPrefix(line);
    const normalized = stripped.endsWith("\n") ? stripped : stripped + "\n";
    this.#streamBuffer += normalized;
    this.#scheduleFlush();
  }

  /**
   * Append a raw NDJSON event. v1: only known `summary` shape is rendered;
   * unknown shapes drop.
   */
  appendEvent(event: Record<string, unknown>): void {
    if (this.#closed) return;
    const rendered = renderEvent(event);
    if (rendered === null) return;
    this.appendOutput(rendered);
  }

  /** Append the IDE's final result (assistant reply). Rendered as plain
   * escaped text below the stream blockquote. */
  appendFinal(text: string): void {
    if (this.#closed) return;
    const normalized = text.endsWith("\n") ? text : text + "\n";
    this.#finalBuffer += normalized;
    this.#scheduleFlush();
  }

  /** Force-flush pending buffer, append terminal marker, stop further appends. */
  async finalize(kind: "ok" | "error", trailer?: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#flushTimer !== undefined) {
      this.#clock.clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    await this.#flushing.catch(() => {});
    const marker = kind === "ok"
      ? OK_MARKER
      : ERR_PREFIX + "<i>" + escapeHtml(trailer ?? "error") + "</i>";
    // Roll over until the body (with closing marker) fits one TG message.
    while (this.#render(marker).length > this.#rolloverAt) {
      if (!(await this.#rolloverOnce())) break;
    }
    const rendered = this.#render(marker);
    if (rendered !== this.#lastSentText) {
      await this.#sender.edit(
        this.#chatId,
        this.#messageId,
        rendered,
        { parseMode: PARSE_MODE },
      );
      this.#lastSentText = rendered;
    }
  }

  // FR-EVENT-STREAM: debounce + rollover
  #scheduleFlush(): void {
    if (this.#flushTimer !== undefined) return;
    const earliest = this.#lastFlushAt + this.#minEditMs;
    const now = this.#clock.now();
    const delay = Math.max(0, earliest - now);
    this.#flushTimer = this.#clock.setTimeout(() => {
      this.#flushTimer = undefined;
      this.#flushing = this.#flush().catch(() => {});
    }, delay);
  }

  async #flush(): Promise<void> {
    if (this.#closed) return;
    if (this.#streamBuffer.length === 0 && this.#finalBuffer.length === 0) {
      return;
    }
    while (this.#render().length > this.#rolloverAt) {
      if (!(await this.#rolloverOnce())) break;
    }
    this.#lastFlushAt = this.#clock.now();
    const rendered = this.#render();
    if (rendered === this.#lastSentText) return; // guard against "message is not modified"
    await this.#sender.edit(
      this.#chatId,
      this.#messageId,
      rendered,
      { parseMode: PARSE_MODE },
    );
    this.#lastSentText = rendered;
  }

  /** Render the current body (without terminal marker unless given). */
  #render(closingMarker = ""): string {
    const parts: string[] = [];
    const s = this.#streamBuffer.replace(/\n+$/, "");
    if (s.length > 0) parts.push(BQ_OPEN + escapeHtml(s) + BQ_CLOSE);
    const f = this.#finalBuffer.replace(/\n+$/, "");
    if (f.length > 0) parts.push(escapeHtml(f));
    return parts.join("\n\n") + closingMarker;
  }

  /** Returns false when there's nothing left to roll over. */
  async #rolloverOnce(): Promise<boolean> {
    if (this.#streamBuffer.length > 0) {
      await this.#rolloverStream();
      return true;
    }
    if (this.#finalBuffer.length > 0) {
      await this.#rolloverFinal();
      return true;
    }
    return false;
  }

  // FR-EVENT-STREAM: rollover (stream half)
  async #rolloverStream(): Promise<void> {
    const budget = this.#rolloverAt - TAG_OVERHEAD - ROLLOVER_MARKER.length;
    const maxHead = Math.max(1, budget);
    const { head, tail } = cutAtNewline(this.#streamBuffer, maxHead);
    const rendered = BQ_OPEN + escapeHtml(head) + ROLLOVER_MARKER + BQ_CLOSE;
    await this.#sender.edit(
      this.#chatId,
      this.#messageId,
      rendered,
      { parseMode: PARSE_MODE },
    );
    const { messageId } = await this.#sender.send(
      this.#chatId,
      this.#placeholder,
      this.#threadId,
      { parseMode: PARSE_MODE },
    );
    this.#messageId = messageId;
    this.#streamBuffer = tail;
    this.#lastSentText = "";
    this.#lastFlushAt = this.#clock.now();
  }

  // FR-EVENT-STREAM: rollover (final half)
  async #rolloverFinal(): Promise<void> {
    const budget = this.#rolloverAt - ROLLOVER_MARKER.length;
    const maxHead = Math.max(1, budget);
    const { head, tail } = cutAtNewline(this.#finalBuffer, maxHead);
    const rendered = escapeHtml(head) + ROLLOVER_MARKER;
    await this.#sender.edit(
      this.#chatId,
      this.#messageId,
      rendered,
      { parseMode: PARSE_MODE },
    );
    const { messageId } = await this.#sender.send(
      this.#chatId,
      this.#placeholder,
      this.#threadId,
      { parseMode: PARSE_MODE },
    );
    this.#messageId = messageId;
    this.#finalBuffer = tail;
    this.#lastSentText = "";
    this.#lastFlushAt = this.#clock.now();
  }
}

function cutAtNewline(
  s: string,
  maxHead: number,
): { head: string; tail: string } {
  if (s.length <= maxHead) return { head: s, tail: "" };
  const nl = s.lastIndexOf("\n", maxHead);
  const splitAt = nl > 0 ? nl + 1 : maxHead;
  return { head: s.slice(0, splitAt), tail: s.slice(splitAt) };
}

/** Minimal event renderer for v1: only known `ai-ide-cli` summary events. */
function renderEvent(event: Record<string, unknown>): string | null {
  // Prefer pre-formatted `summary` field when present (future-proof).
  const summary = event["summary"];
  if (typeof summary === "string" && summary.length > 0) return summary;
  return null;
}
