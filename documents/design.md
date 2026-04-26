# SDS

## 1. Intro
- **Purpose:** Describe how `tg-ide-bridge` is built: process model, modules, data, and key algorithms. Implementation reference for every task.
- **Rel to SRS:** Implements FR-TG-POLL, FR-CMD-EXEC, FR-SESSION-RESUME, FR-RESPONSE-STREAM, FR-EVENT-STREAM, FR-AUTH, FR-CONFIG, FR-SETTINGS.

## 2. Arch
- **Diagram:**
  ```mermaid
  flowchart LR
    TG[Telegram Bot API] -- long poll --> Poller
    subgraph Daemon[Daemon per project]
      Poller --> Auth
      Auth --> Dispatcher
      Dispatcher --> Session[(Session store<br/>.tg-ide-bridge/session.json)]
      Dispatcher --> SessionMgr[SessionManager<br/>long-lived RuntimeSession]
      Dispatcher --> IDE[jsr:@korchasa/ai-ide-cli RuntimeAdapter]
      SessionMgr --> IDE
      IDE -- onEvent/onOutput --> Streamer
      IDE -- final result --> Chunker
      SessionMgr -- per-turn events / turn-end --> Streamer
      Streamer --> Sender
      Chunker --> Sender
    end
    Sender -- sendMessage/editMessageText --> TG
  ```
- **Subsystems:**
  - **Poller** — TG long-polling loop, offset management, retry/backoff.
  - **Auth** — chat/topic whitelist filter.
  - **Dispatcher** — maps TG update → IDE call. Owns a per-turn `AbortController` that `/stop` fires, replacing the previous `killAll`-based kill path. Route selection: if `ide.capabilities.session` and a `SessionManager` is wired, session-mode path (one long-lived IDE subprocess, turns demultiplexed); otherwise invoke-mode fallback (one-shot `invoke` per turn).
  - **SessionManager** (session-mode path) — wraps `RuntimeAdapter.openSession`. Opens lazily on first turn, reuses across turns, reopens on settings change, demultiplexes the single event stream into per-turn `LiveHandle`s using `SYNTHETIC_TURN_END` as the boundary. Persists `RuntimeSession.sessionId` to `SessionStore` on change. `/stop` → `session.abort()`; `/reset` → abort + clear stored id.
  - **Session store** — persistent `--resume` / `sessionId` token + runtime settings.
  - **Streamer** — maintains a live TG message edited in place as IDE events arrive; rolls over to a new message before the 4096-char limit; respects ≤1 edit/sec per chat via debounced flush.
  - **Chunker/Sender** — fallback path for non-streaming runtimes: splits long final output into ≤4096-char TG messages on newline boundaries; underlying `Sender` also exposes `sendMessage`/`editMessageText`/`sendChatAction` used by `Streamer`.

## 3. Components

### 3.1 `engine/cli.ts`
- **Purpose:** Entrypoint. Loads env-based config, constructs daemon, runs main loop. No CLI flags — all configuration via env vars (loaded from `.env` at task level via `deno run --env-file=.env`). Instantiates `SessionManager` when `ide.capabilities.session` is true (all runtimes in `ai-ide-cli@^0.5.2`) and passes it to `Dispatcher`. On SIGINT/SIGTERM awaits `dispatcher.close()` so the long-lived IDE subprocess receives SIGTERM and persist-writes drain.
- **Interfaces:** `main(args: string[]): Promise<number>`.
- **Deps:** config loader, `Sender`, `Poller`, `Dispatcher`, `SessionStore`, `SessionManager`, `getRuntimeAdapter` from `@korchasa/ai-ide-cli`.

### 3.2 `engine/config.ts`
- **Purpose:** Load/validate deploy-time config from env only (FR-CONFIG). Runtime IDE params are not here — see `engine/settings.ts` / `SessionStore`.
- **Interfaces:** `loadConfig(env, opts?): Config`; `Config { token; allowed_chat_ids: number[]; allowed_thread_ids?: number[]; ide: "claude"|"opencode"|"cursor"; project_dir: string }`. `project_dir` defaults to `Deno.cwd()`.
- **Env vars:** `FLOWAI_TELEGRAM_BOT_TOKEN`, `FLOWAI_TELEGRAM_CHAT_ID`, `FLOWAI_TELEGRAM_ALLOWED_THREAD_IDS?`, `FLOWAI_BRIDGE_IDE`.
- **Deps:** none.

### 3.3 `engine/tg/poller.ts`
- **Purpose:** TG long-polling loop with offset tracking and backoff (FR-TG-POLL).
- **Interfaces:** `Poller.run(onUpdate: (u: Update) => Promise<void>): Promise<void>`.
- **Deps:** `fetch` (native), `Config`.

### 3.4 `engine/tg/sender.ts`
- **Purpose:** Low-level TG Bot API client. Send/edit messages; chunk long responses (FR-RESPONSE-STREAM).
- **Interfaces:** `send(chatId, text, threadId?): Promise<{ messageId: number }>`; `edit(chatId, messageId, text): Promise<void>`; `sendChatAction(chatId, action, threadId?): Promise<void>`; `setMyCommands(commands): Promise<void>`; `chunkText(text: string): string[]`.
- **Deps:** `fetch`.

### 3.5 `engine/auth.ts`
- **Purpose:** Filter updates by whitelist (FR-AUTH).
- **Interfaces:** `isAllowed(update: Update, cfg: Config): boolean`.

### 3.6 `engine/session.ts`
- **Purpose:** Persist and load per-IDE `--resume` token and runtime settings (FR-SESSION-RESUME, FR-SETTINGS) atomically in one JSON file. Each `SessionStore` is scoped to one `SupportedIde`; the file holds an `ides: { [ide]: { session?, settings? } }` map so switching `FLOWAI_BRIDGE_IDE` between runs doesn't cross-contaminate conversations or tuning.
- **Interfaces:** `new SessionStore(baseDir, ide, opts?)`; `loadSession(): Promise<string|null>`; `saveSession(token): Promise<void>`; `resetSession(): Promise<void>`; `loadSettings(): Promise<StoredSettings>`; `saveSettings(patch: Partial<StoredSettings>): Promise<void>`; `resetSettings(): Promise<void>`. All methods operate on the slot for the `ide` passed to the constructor; other IDEs' data is preserved untouched.
- **Migration:** legacy flat `{token, updatedAt}` (pre-v0.2) and intermediate `{session, settings}` (v0.1.x) shapes are auto-read into the current store's IDE slot; the next write rewrites the file in the new per-IDE shape.
- **Deps:** `@std/path`, `SupportedIde` from `engine/config.ts`, `StoredSettings` from `engine/settings.ts`.

### 3.7 `engine/dispatcher.ts`
- **Purpose:** For each message: parse slash commands (`/reset`, `/stop`, `/settings`, `/model`, `/effort`, `/perm`, `/timeout`, `/retries`, `/retry_delay`) → otherwise load session + effective settings → open live TG message via `Streamer` → route to IDE (FR-CMD-EXEC, FR-EVENT-STREAM, FR-SETTINGS). Route selection: `SessionManager` + `Streamer` → session-mode; `Streamer` only → invoke-mode streamed; neither → invoke-mode batched (tests). `onOutput` is intentionally not wired: the rich event renderer covers the same content with structured args. All commands except `/stop` serialize behind a promise queue; `/stop` short-circuits by calling `ctrl.abort()` on the per-turn `AbortController` — that signal is plumbed into both `ide.invoke({..., signal})` (invoke-mode) and `SessionManager.runTurn({..., stopSignal})` (session-mode), replacing the former `killAll` registry dep. `/reset` clears in-memory session state via `SessionManager.reset()` (which also wipes the stored id) then clears the store. `effort` is mapped to `extraArgs: { "--effort": <val> }` for `ide=claude` only; other IDEs ignore it. `close()` on daemon shutdown drains `SessionManager.close()`.
- **Interfaces:** `handle(update: Update): Promise<void>`; `close(): Promise<void>`.
- **Deps:** `SessionStore`, `Sender`, `Streamer`, `SessionManager` (optional), `RuntimeAdapter` from `@korchasa/ai-ide-cli`, validators from `engine/settings.ts`.

### 3.9 `engine/settings.ts`
- **Purpose:** Runtime-tunable IDE settings domain (FR-SETTINGS). Defines `StoredSettings`/`EffectiveSettings`, per-IDE whitelists (`WHITELISTS`), numeric ranges (`NUMERIC_RANGES`), validators returning a discriminated `ValidationResult`, and pure formatter (`formatSettings`).
- **Interfaces:** `effectiveSettings(stored): EffectiveSettings`; `validateModel|Effort|PermissionMode(ide, raw)`; `validateTimeoutSeconds|MaxRetries|RetryDelaySeconds(raw)`; `formatSettings(ide, stored): string`.
- **Deps:** `SupportedIde` from `engine/config.ts`.

### 3.8 `engine/tg/streamer.ts`
- **Purpose:** Render IDE event/output stream into an edit-in-place TG "live" message with rate-limited flush and 4096-char rollover (FR-EVENT-STREAM). Uses Bot API HTML parse mode: stream lines rendered inside `<blockquote expandable>…</blockquote>`, final assistant text rendered below via `markdownToTelegramHTML` (native bold/italic/code/headers/links/blockquotes).
- **Interfaces:**
  - `Streamer.open(chatId: number, threadId?: number): Promise<LiveHandle>`.
  - `LiveHandle.appendEvent(event: Record<string, unknown>): void` — runs the rich event renderer over an `@korchasa/ai-ide-cli` NDJSON event and appends the resulting HTML lines to the stream buffer; unknown event shapes drop silently.
  - `LiveHandle.appendOutput(line: string): void` — appends a raw `onOutput` line to the stream buffer; strips leading `[stream]` and `text:` prefixes and HTML-escapes the remainder. Retained as a fallback channel (not wired by `Dispatcher`).
  - `LiveHandle.appendFinal(text: string): void` — appends raw Markdown to the final-result buffer; converted to TG HTML at render time and rendered outside the blockquote.
  - `LiveHandle.finalize(kind: "ok"|"error", trailer?: string): Promise<void>` — forces a final flush; on `error` appends `<b>✗</b> <i>trailer</i>`, on `ok` adds no marker; stops accepting further appends.
- **Render:** `<blockquote expandable>${streamBuf}</blockquote>` + optional `\n\n${markdownToTelegramHTML(finalBuf)}` + optional terminal marker. `streamBuf` already holds pre-escaped HTML so it is not re-escaped on render; `finalBuf` stays in raw Markdown until render so rollover cuts on source-newline boundaries. Empty buffers are skipped. Sent with `parse_mode: "HTML"`; only `<`, `>`, `&` are HTML-escaped at append time. `<pre>` intentionally never appears inside `<blockquote>` (TG rejects that nesting) — this is why the converter is applied to `finalBuf` only.
- **Event renderer:** pure function mapping Claude NDJSON / normalized-content shapes to emoji-prefixed HTML lines:
  - `system/init` → `⚙️ <code>{model}</code>`.
  - `assistant.message.content[*].tool_use` (and runtime-neutral `kind:"tool"` normalized parts) → `🛠️ <b>{name}</b> {detail}`. A single generic emoji runs across all runtimes — per-tool emoji maps drift the moment Claude/codex/opencode rename a tool.
  - `detail` is a probe-list lookup over `input` against the ordered key list `description`, `command`, `query`, `pattern`, `url`, `file_path`, `notebook_path`, `filePath`, `path`; first string-valued match wins and renders as `<code>{value}</code>` with homedir-style prefixes stripped and long values truncated to 80 chars.
  - Assistant text blocks (`assistant.message.content[*].text` and normalized `kind:"text"` parts, both cumulative and delta) are deliberately dropped — the final reply is fed through `appendFinal` and rendered below the blockquote with full Markdown. Previewing the same text inline would duplicate the answer with raw markdown symbols (`**`, backticks) visible as characters, since the stream blockquote is HTML-only (no nested Markdown→HTML conversion to avoid `<pre>` nesting inside `<blockquote>`).
  - All other event shapes (incl. `result`) drop — `finalize()` owns the closing UI and `appendFinal` carries the assistant reply.
- **Edit dedupe:** skip `editMessageText` when rendered body equals the last successfully sent body (guards against TG's `message is not modified` error).
- **Deps:** `Sender` (`send`, `edit` with `parseMode: "HTML"`), `setTimeout` (debounce), event renderer, `engine/tg/format.ts` (`escapeHtml`, `markdownToTelegramHTML`).

### 3.11 `engine/ide_session.ts`
- **Purpose:** Session-mode IDE invocation. Wraps `RuntimeAdapter.openSession` into a per-turn API (FR-CMD-EXEC, FR-SESSION-RESUME, FR-EVENT-STREAM). One `RuntimeSession` = many turns, each with its own `LiveHandle`. Avoids the ~2–5s subprocess start-up latency the invoke-mode path paid per user message.
- **Interfaces:**
  - `new SessionManager({ ide, ideId, cwd, store?, log })` — throws if `ide.capabilities.session` is false or `openSession` is absent.
  - `runTurn({ live, text, settings, stopSignal }): Promise<void>` — opens session on first call; sends `text`; drains session events into `live`; on `SYNTHETIC_TURN_END` writes final assistant text (from `raw.result` or accumulated assistant text) then `live.finalize("ok"|"error")`.
  - `stop(): Promise<void>` — abort active session (keeps stored id for resume).
  - `reset(): Promise<void>` — abort + clear stored id → next turn opens fresh conversation.
  - `close(): Promise<void>` — daemon shutdown.
  - `hasActiveSession: boolean`.
- **Key algorithms:**
  - **Turn routing**: background drain task iterates `session.events`; while a turn is active, routes `assistant` events to `LiveHandle.appendEvent` and accumulates text-block content (`lastAssistantText`, overwritten per message) as fallback final text; on `SYNTHETIC_TURN_END` resolves the turn-completion deferred.
  - **Session-id persistence**: every event checks `session.sessionId` (Claude populates after `system/init`); if changed, queues an atomic write onto a persist chain. `close()` awaits the chain so no writes are dropped on shutdown.
  - **Settings snapshot**: `model`/`effort`/`permissionMode` captured at open time. On next turn, differing snapshot → `#closeSession` + reopen with prior `sessionId` as `resumeSessionId`. `timeoutSeconds`/`maxRetries`/`retryDelaySeconds` do NOT apply in session-mode (`ai-ide-cli`'s `RuntimeSession` has no timeout/retry — per-turn cancellation is the caller's job via `stopSignal`).
  - **Stop**: `stopSignal` abort → set `#stoppedByUser = true` → `#sessionAbort.abort()`. Session dies → drain exits → pending turn resolves `isError: true, errorDetail: "stopped by user"`; LiveHandle finalizes with `✗`.
  - **Unexpected termination**: drain catches errors from events iterable; if the current turn is in flight, resolves it with `"session terminated unexpectedly"`.
- **Deps:** `RuntimeAdapter`, `RuntimeSession`, `RuntimeSessionEvent`, `SYNTHETIC_TURN_END` from `@korchasa/ai-ide-cli`; `SessionStore`, `SupportedIde`, `EffectiveSettings`, `LiveHandle`, `Logger`.
- **Constraints (v1):** one concurrent turn per manager (dispatcher serializes). No per-turn timeout. Same `effortToExtraArgs` mapping as `Dispatcher` (Claude-only `--effort`).

### 3.10 `engine/tg/format.ts`
- **Purpose:** Pure Markdown → Telegram HTML converter (FR-EVENT-STREAM). Targets TG's `parse_mode: "HTML"` rule set: minimal 3-char escape (`<`/`>`/`&`), `#..######` → `<b>`, `**bold**` → `<b>`, `*x*`/`_x_` → `<i>`, `` `x` `` → `<code>`, fenced blocks → `<pre><code class="language-…">`, `[t](u)` → `<a>`, `> q` → `<blockquote>`. Fenced blocks, `> `-blocks, and inline `` `code` `` spans are stashed into Private-Use-Area placeholders before bold/italic/link passes; bold/italic body classes also exclude `<` so those passes cannot reach across emitted tags (`<a>`, `<b>`, `<i>`). Remaining plain text is escaped so stray `<`/`>`/`&` cannot confuse the TG parser. Unclosed bold/italic markers stay literal (Markdown-standard semantics) — symmetric for `**` and `_`.
- **Interfaces:** `escapeHtml(text: string): string`; `markdownToTelegramHTML(input: string|null|undefined): string`.
- **Deps:** none.
- **Known limitations:** `***x***` → `<i>&lt;b&gt;x&lt;/b&gt;</i>` (nested bold inside italic gets re-escaped); Markdown inside `#` headers is escaped, not nested; fenced blocks cut across a rollover boundary degrade to plain text on the boundary — acceptable (data preserved, styling only); inline `` `code` `` spans must not contain newlines (multi-line spans degrade to literal text).

### 3.12 `engine/capabilities.ts`
- **Purpose:** Discover IDE skills/slash-commands and expose them as TG bot commands (FR-CAPABILITY-INVENTORY). Pure CRUD over a JSON cache; discovery is delegated to `RuntimeAdapter.fetchCapabilitiesSlow`.
- **Interfaces:**
  - `sanitizeName(raw: string): string | null` — lower-cases, replaces `-`/`.`/whitespace with `_`, drops chars outside `[a-z0-9_]`, truncates to 32. Returns `null` on empty result.
  - `buildRegistry(inv, reserved): { registry, skipped }` — sanitizes inventory, drops collisions with reserved and post-sanitize duplicates, caps total at `100 - reserved.size` (commands first, then skills, alphabetical by tgName).
  - `loadRegistry(projectDir): Promise<CapabilityRegistry | null>` / `saveRegistry(projectDir, reg): Promise<void>` — atomic write under `.tg-ide-bridge/capabilities.json`, mode 0600 (same pattern as `SessionStore`).
  - `mergeCommandList(reserved, registry): { command; description }[]` — input for `Sender.setMyCommands`.
  - `lookupOriginal(registry, tgName): string | null` — used by dispatcher to rewrite `/<tgName>` → `/<originalName>`.
- **Data:**
  - `CapabilityRegistry { runtime, fetchedAt, entries: CapabilityEntry[] }`.
  - `CapabilityEntry { tgName, originalName, kind: "skill"|"command", description }`.
- **Deps:** `@std/path`, `@std/fs` for atomic write; `CapabilityInventory`, `CapabilityRef` from `@korchasa/ai-ide-cli`.

## 4. Data
- **Entities:**
  - `Config` — deploy-time env-loaded config.
  - `Update` — TG Bot API update (subset: `message.chat.id`, `message.message_thread_id`, `message.text`).
  - `SessionSection` — `{ token: string, updatedAt: string }`.
  - `IdeState` — per-IDE slot: `{ session?: SessionSection, settings?: StoredSettings }`.
  - `StoredSettings` — every field optional: `{ model?, effort?, permissionMode?, timeoutSeconds?, maxRetries?, retryDelaySeconds? }`.
- **ERD:** flat; no DB. Single JSON file `.tg-ide-bridge/session.json` shaped as `{ ides: { [ide]: IdeState } }`. Empty IDE slots are removed; when `ides` becomes empty, the file itself is removed.
- **Migration:** (1) legacy flat `{token, updatedAt}` — pre-v0.2, single-IDE → read into current store's `ides[<ide>].session`. (2) intermediate `{session, settings}` — v0.1.x, single-IDE → same. Next write rewrites in per-IDE shape. Automatic, no user action required.

## 5. Logic
- **Algos:**
  - **Long poll loop**: `offset = 0`; request `getUpdates?offset=<offset>&timeout=25`; for each update set `offset = update_id + 1`; on network error, exponential backoff capped at 30 s.
  - **Response chunking** (fallback): if `len(text) <= 4000` send as-is; else split at last `\n` ≤4000 chars; fallback to hard cut at 4000 if no newline.
  - **Live-edit rollover**: per-invocation `LiveHandle` holds `{ messageId, streamBuffer, finalBuffer, lastFlushAt, lastSentText, closed }`. `appendEvent` pushes pre-escaped HTML lines (rendered by the event renderer); `appendOutput` HTML-escapes its raw input first; both then schedule a flush. Stream lines are stored already-escaped so `\n` boundaries are safe rollover cut points. `appendFinal` pushes into `finalBuffer`. Flush renders the full HTML body; if length > `rolloverAt` (default 3800), split `streamBuffer` at last `\n` inside the tag-overhead-adjusted budget, finalize the current message with `\n…`, open a new TG message with the tail. Edits are skipped when `rendered === lastSentText`. On `finalize` the scheduled flush is forced and no further appends are accepted.
  - **Session update (invoke-mode)**: after IDE invocation, extract new `session_id` from `RuntimeInvokeResult.output`, atomically write to `.tg-ide-bridge/session.json` via temp-file-rename.
  - **Session update (session-mode)**: `SessionManager` polls `RuntimeSession.sessionId` on every event; when it changes (populated by Claude after `system/init`, synchronous for others), queues an atomic write onto a serialized persist chain. Chain is awaited on `close()` so SIGINT/SIGTERM doesn't lose the id.
  - **Settings merge**: on each IDE invocation `dispatcher` reads `StoredSettings` from session store and overlays `DEFAULT_SETTINGS` to produce `EffectiveSettings`. Commands `/<field> <value>` write via `SessionStore.saveSettings({[field]: val})`; `clear` writes `undefined` (deletes the field).
  - **Whitelists**: `WHITELISTS[ide]` is consulted for `model`/`effort`/`permissionMode` validation. Empty whitelist ⇒ field rejected as "not supported for ide '<ide>'". Numeric validation uses `NUMERIC_RANGES`.
- **Rules:**
  - Deploy-time config (including bot token) is read only from environment variables; never logged. `.env` loaded by the task runner (`--env-file=.env`).
  - Runtime IDE params live in session.json, not env. `/reset` clears only the session token; runtime settings survive `/reset`.
  - `Streamer` never exceeds 1 edit/sec per chat; bursts of events are coalesced into the next flush — latency is bounded by this rate on purpose.
  - Event rendering is lossy by design (drops unknown kinds, trims long tool payloads); the final `result` from `RuntimeInvokeResult.output` is always appended verbatim before `finalize("ok")`.

## 6. Non-Functional
- **Scale/Fault/Sec/Logs:**
  - **Scale**: single process, single chat. No concurrency beyond one in-flight IDE call per daemon.
  - **Fault**: all network errors retried with backoff; IDE subprocess failure reported to chat with exit code + stderr tail.
  - **Sec**: token in env; whitelist enforced before any IDE call; session file mode `0600`.
  - **Logs**: structured JSON to stderr; levels `info`/`warn`/`error`; no secrets.

## 7. Constraints
- **Simplified/Deferred:**
  - Multi-project / multi-chat routing — deferred.
  - Webhook mode — deferred.
  - Attachments (files, images from TG) — deferred.
  - Inline keyboards and rich UI — deferred.
  - Concurrent message handling — deferred (queue in v2).
