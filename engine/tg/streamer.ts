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
 * final assistant result is rendered below via `markdownToTelegramHTML`
 * (headers/bold/italic/code/links/blockquotes → native TG HTML).
 *
 * The stream buffer holds pre-escaped HTML (each line is a complete chunk);
 * `appendOutput` escapes raw text on the way in, while `appendEvent` /
 * `appendNormalized` run the rich renderer that emits emoji + `<code>`-wrapped
 * arguments for known IDE tools. Assistant text is intentionally NOT previewed
 * in the blockquote — the final reply is fed through `appendFinal` and
 * rendered below with full Markdown, so inline previews would duplicate it
 * with raw markdown symbols leaking. The final buffer stays in raw Markdown
 * until render time so that rollover can still cut on source-text newline
 * boundaries.
 */

import type { Sender } from "./sender.ts";
import { escapeHtml, markdownToTelegramHTML } from "./format.ts";
import type { NormalizedContent } from "@korchasa/ai-ide-cli";

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
// Single emoji (no surrounding text) so TG clients render it in large-emoji
// mode and auto-animate it until the first real edit lands.
const DEFAULT_PLACEHOLDER = "🤔";
const PARSE_MODE = "HTML";
const BQ_OPEN = "<blockquote expandable>";
const BQ_CLOSE = "</blockquote>";
const TAG_OVERHEAD = BQ_OPEN.length + BQ_CLOSE.length;
const ROLLOVER_MARKER = "\n…";
const ERR_PREFIX = "\n\n<b>✗</b> ";
const STREAM_PREFIX_RE = /^\[stream\](?:\s+|$)/;
const TEXT_PREFIX_RE = /^text:\s*/;

// Single emoji for every tool — runtime-agnostic. Avoids per-IDE name maps
// that drift the moment Claude/codex/opencode rename a tool.
const TOOL_EMOJI = "🛠️";
const MAX_TOOL_DETAIL = 80;
// Ordered probe list. First string-valued match wins. Names span Claude
// snake_case (`file_path`), codex camelCase (`filePath`), and shared keys
// (`command`, `query`, `pattern`, `url`, `path`). `description` first so an
// explicit human-friendly summary (e.g. Bash description) beats raw args.
const PRIMARY_DETAIL_KEYS = [
  "description",
  "command",
  "query",
  "pattern",
  "url",
  "file_path",
  "notebook_path",
  "filePath",
  "path",
] as const;

function stripStreamPrefix(line: string): string {
  return line.replace(STREAM_PREFIX_RE, "").replace(TEXT_PREFIX_RE, "");
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
  /** Pre-escaped HTML; lines separated by `\n` so rollover can split at boundaries. */
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
    this.#pushStream(escapeHtml(stripped));
  }

  /**
   * Append a runtime-neutral `NormalizedContent` part from
   * `ai-ide-cli`'s `extractSessionContent`. Only tool invocations render
   * (as `{emoji} <b>{name}</b> {detail}`); assistant text (cumulative
   * or delta) and `final` parts are dropped here — the final reply is
   * fed into `appendFinal` separately and renders below the blockquote
   * with full Markdown, so previewing the same text inline would just
   * duplicate it with raw markdown symbols leaking.
   */
  appendNormalized(part: NormalizedContent): void {
    if (this.#closed) return;
    const line = renderNormalized(part);
    if (line === null) return;
    this.#pushStream(line);
  }

  /**
   * Append a raw NDJSON event from `ai-ide-cli`. Known Claude shapes
   * (system init, assistant text/tool_use) render as one or more emoji-led
   * HTML lines; unrecognized shapes drop. Kept for the invoke-mode path in
   * `Dispatcher`; session-mode uses `appendNormalized` instead.
   */
  appendEvent(event: Record<string, unknown>): void {
    if (this.#closed) return;
    const rendered = renderEvent(event);
    if (rendered === null) return;
    this.#pushStream(rendered);
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
      ? ""
      : ERR_PREFIX + "<i>" + escapeHtml(trailer ?? "error") + "</i>";
    // Roll over until the body (with closing marker) fits one TG message.
    while (this.#render(marker).length > this.#rolloverAt) {
      if (!(await this.#rolloverOnce())) break;
    }
    const rendered = this.#render(marker);
    if (rendered.length === 0) return;
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

  #pushStream(html: string): void {
    const normalized = html.endsWith("\n") ? html : html + "\n";
    this.#streamBuffer += normalized;
    this.#scheduleFlush();
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
    if (s.length > 0) parts.push(BQ_OPEN + s + BQ_CLOSE);
    const f = this.#finalBuffer.replace(/\n+$/, "");
    if (f.length > 0) parts.push(markdownToTelegramHTML(f));
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
    const rendered = BQ_OPEN + head + ROLLOVER_MARKER + BQ_CLOSE;
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
    // Markdown→HTML can inflate the source by a variable factor (e.g. `code`
    // → <code>code</code>). Shrink the source cut iteratively until the
    // rendered body with rollover marker fits the per-message budget.
    let maxHead = Math.max(1, this.#rolloverAt - ROLLOVER_MARKER.length);
    let cut = cutAtNewline(this.#finalBuffer, maxHead);
    let rendered = markdownToTelegramHTML(cut.head) + ROLLOVER_MARKER;
    while (rendered.length > this.#rolloverAt && cut.head.length > 1) {
      const ratio = this.#rolloverAt / rendered.length;
      const next = Math.max(1, Math.floor(maxHead * ratio) - 1);
      maxHead = next < maxHead ? next : maxHead - 1;
      cut = cutAtNewline(this.#finalBuffer, maxHead);
      rendered = markdownToTelegramHTML(cut.head) + ROLLOVER_MARKER;
    }
    const tail = cut.tail;
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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Common dev-machine path prefixes (homedir-style or container workspace).
const PATH_PREFIX_RE =
  /^(?:\/workspaces\/[^/]+|\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+)\//;

function shortenPath(p: string): string {
  return p.replace(PATH_PREFIX_RE, "");
}

function code(s: string): string {
  return `<code>${escapeHtml(truncate(s, MAX_TOOL_DETAIL))}</code>`;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Generic tool-detail extractor. Probes `input` against an ordered list of
 * commonly-used string keys and renders the first hit as `<code>`-wrapped,
 * truncated, HTML-escaped text. Path-shaped values get the homedir prefix
 * stripped. Returns `""` when no probe matches — caller renders just the
 * tool name in that case.
 *
 * Runtime-agnostic by design: works for Claude `Bash`/`Read`/`Grep`, codex
 * `commandExecution`/`fileChange`/`webSearch`, MCP tool inputs, and any
 * future tool whose payload uses one of the listed keys.
 */
function fmtToolDetail(
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return "";
  for (const key of PRIMARY_DETAIL_KEYS) {
    const v = asString(input[key]);
    if (!v) continue;
    return code(shortenPath(v));
  }
  return "";
}

/**
 * Render one normalized content part as an HTML line (escaped, may contain
 * `<code>`/`<b>`). Only tool invocations render in the stream blockquote;
 * assistant text (cumulative or delta) and `final` are dropped — the final
 * reply is owned by `appendFinal` and rendered outside the blockquote, so
 * previewing it inline duplicates the same content with markdown symbols
 * leaking as raw characters.
 */
function renderNormalized(part: NormalizedContent): string | null {
  if (part.kind === "tool") {
    const detail = fmtToolDetail(part.input);
    const prefix = `${TOOL_EMOJI} <b>${escapeHtml(part.name)}</b>`;
    return detail ? `${prefix} ${detail}` : prefix;
  }
  return null;
}

/** Render one IDE event as 0+ HTML lines (escaped, may contain `<code>`/`<b>`). */
function renderEvent(event: Record<string, unknown>): string | null {
  const type = event.type;
  if (type === "system" && event.subtype === "init") {
    const model = asString(event.model) ?? "?";
    return `⚙️ <code>${escapeHtml(model)}</code>`;
  }
  if (type === "assistant") {
    const message = event.message as { content?: unknown } | undefined;
    const contents = message?.content;
    if (!Array.isArray(contents)) return null;
    const lines: string[] = [];
    for (const block of contents as Array<Record<string, unknown>>) {
      // Text blocks deliberately skipped — the cumulative assistant text
      // IS the final reply for Claude/Cursor, and `appendFinal` renders it
      // outside the blockquote with proper Markdown. Previewing it inline
      // would duplicate the answer with raw `**` / backticks leaking.
      if (block.type === "tool_use") {
        const name = asString(block.name) ?? "?";
        const detail = fmtToolDetail(
          block.input as Record<string, unknown> | undefined,
        );
        const prefix = `${TOOL_EMOJI} <b>${escapeHtml(name)}</b>`;
        lines.push(detail ? `${prefix} ${detail}` : prefix);
      }
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }
  // Result + everything else: finalize() owns the closing UI; no inline render.
  return null;
}
