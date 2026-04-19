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
      Dispatcher --> IDE[jsr:@korchasa/ai-ide-cli RuntimeAdapter]
      IDE -- onEvent/onOutput --> Streamer
      IDE -- final result --> Chunker
      Streamer --> Sender
      Chunker --> Sender
    end
    Sender -- sendMessage/editMessageText --> TG
  ```
- **Subsystems:**
  - **Poller** — TG long-polling loop, offset management, retry/backoff.
  - **Auth** — chat/topic whitelist filter.
  - **Dispatcher** — maps TG update → IDE invocation; owns session lifecycle. Calls `RuntimeAdapter.invoke` from `@korchasa/ai-ide-cli` directly, wiring `onEvent`/`onOutput` into `Streamer`.
  - **Session store** — persistent `--resume` token.
  - **Streamer** — maintains a live TG message edited in place as IDE events arrive; rolls over to a new message before the 4096-char limit; respects ≤1 edit/sec per chat via debounced flush.
  - **Chunker/Sender** — fallback path for non-streaming runtimes: splits long final output into ≤4096-char TG messages on newline boundaries; underlying `Sender` also exposes `sendMessage`/`editMessageText`/`sendChatAction` used by `Streamer`.

## 3. Components

### 3.1 `engine/cli.ts`
- **Purpose:** Entrypoint. Loads env-based config, constructs daemon, runs main loop. No CLI flags — all configuration via env vars (loaded from `.env` at task level via `deno run --env-file=.env`).
- **Interfaces:** `main(args: string[]): Promise<number>`.
- **Deps:** config loader, `Sender`, `Poller`, `Dispatcher`, `SessionStore`, `getRuntimeAdapter` from `@korchasa/ai-ide-cli`.

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
- **Purpose:** Persist and load IDE `--resume` token and runtime settings (FR-SESSION-RESUME, FR-SETTINGS) atomically in one JSON file.
- **Interfaces:** `loadSession(): Promise<string|null>`; `saveSession(token): Promise<void>`; `resetSession(): Promise<void>`; `loadSettings(): Promise<StoredSettings>`; `saveSettings(patch: Partial<StoredSettings>): Promise<void>`; `resetSettings(): Promise<void>`. Legacy flat `{token, updatedAt}` format is auto-migrated on read.
- **Deps:** `@std/path`, `StoredSettings` from `engine/settings.ts`.

### 3.7 `engine/dispatcher.ts`
- **Purpose:** For each message: parse slash commands (`/reset`, `/stop`, `/settings`, `/model`, `/effort`, `/perm`, `/timeout`, `/retries`, `/retry_delay`) → otherwise load session + effective settings → open live TG message via `Streamer` → invoke IDE with `onEvent` wired into `LiveHandle.appendEvent` (rich renderer) → update session → finalize live message (FR-CMD-EXEC, FR-EVENT-STREAM, FR-SETTINGS). `onOutput` is intentionally not wired: the rich event renderer covers the same content with structured args, so wiring both would duplicate every line. `/stop` short-circuits the per-dispatcher promise queue so it reaches the in-flight call; all other commands serialize normally. Calls `RuntimeAdapter.invoke({ taskPrompt, resumeSessionId?, cwd, timeoutSeconds, maxRetries, retryDelaySeconds, permissionMode?, model?, extraArgs?, onEvent })` on `@korchasa/ai-ide-cli` directly. `effort` is mapped to `extraArgs: ["--effort", <val>]` for `ide=claude` only; other IDEs ignore it.
- **Interfaces:** `handle(update: Update): Promise<void>`.
- **Deps:** `SessionStore`, `Sender`, `Streamer`, `RuntimeAdapter` from `@korchasa/ai-ide-cli`, validators from `engine/settings.ts`.

### 3.9 `engine/settings.ts`
- **Purpose:** Runtime-tunable IDE settings domain (FR-SETTINGS). Defines `StoredSettings`/`EffectiveSettings`, per-IDE whitelists (`WHITELISTS`), numeric ranges (`NUMERIC_RANGES`), validators returning a discriminated `ValidationResult`, and pure formatter (`formatSettings`).
- **Interfaces:** `effectiveSettings(stored): EffectiveSettings`; `validateModel|Effort|PermissionMode(ide, raw)`; `validateTimeoutSeconds|MaxRetries|RetryDelaySeconds(raw)`; `formatSettings(ide, stored): string`.
- **Deps:** `SupportedIde` from `engine/config.ts`.

### 3.8 `engine/tg/streamer.ts`
- **Purpose:** Render IDE event/output stream into an edit-in-place TG "live" message with rate-limited flush and 4096-char rollover (FR-EVENT-STREAM). Uses Bot API HTML parse mode: stream lines rendered inside `<blockquote expandable>…</blockquote>`, final assistant text rendered below as plain escaped text.
- **Interfaces:**
  - `Streamer.open(chatId: number, threadId?: number): Promise<LiveHandle>`.
  - `LiveHandle.appendEvent(event: Record<string, unknown>): void` — runs the rich event renderer over an `@korchasa/ai-ide-cli` NDJSON event and appends the resulting HTML lines to the stream buffer; unknown event shapes drop silently.
  - `LiveHandle.appendOutput(line: string): void` — appends a raw `onOutput` line to the stream buffer; strips leading `[stream]` and `text:` prefixes and HTML-escapes the remainder. Retained as a fallback channel (not wired by `Dispatcher`).
  - `LiveHandle.appendFinal(text: string): void` — appends to the final-result buffer (rendered as plain text, outside the blockquote).
  - `LiveHandle.finalize(kind: "ok"|"error", trailer?: string): Promise<void>` — forces a final flush; on `error` appends `<b>✗</b> <i>trailer</i>`, on `ok` adds no marker; stops accepting further appends.
- **Render:** `<blockquote expandable>${streamBuf}</blockquote>` + optional `\n\n${escape(finalBuf)}` + optional terminal marker. `streamBuf` already holds pre-escaped HTML so it is not re-escaped on render. Empty buffers are skipped. Sent with `parse_mode: "HTML"`; only `<`, `>`, `&` are HTML-escaped at append time.
- **Event renderer:** pure function mapping Claude NDJSON shapes to emoji-prefixed HTML lines:
  - `system/init` → `⚙️ <code>{model}</code>`.
  - `assistant.message.content[*].text` → `💬 {preview}` (collapsed whitespace, truncated to 200 chars).
  - `assistant.message.content[*].tool_use` → `{emoji} <b>{name}</b> {detail}`. Tool→emoji map covers `Read 📖`, `Write 📝`, `Edit ✏️`, `MultiEdit ✂️`, `Bash 🐚`, `Grep 🔍`, `Glob 📁`, `Agent`/`Task 🤖`, `WebFetch 🌐`, `WebSearch 🔎`, `TodoWrite 📋`, `NotebookEdit`/`NotebookRead 📓`; unknown tools fall back to `🛠️`.
  - `detail` is per-tool: file-touching tools render `<code>{shortened path}</code>`; `Bash` prefers `description` (plain) over `<code>{command}</code>`; `Grep` shows `<code>/{pattern}/</code>` and optional `in <code>{path}</code>`; `Glob`, `WebFetch`, `WebSearch` show their primary arg in `<code>`; `Agent`/`Task` show `description`; `TodoWrite` shows `{N} items`. Long values are truncated to 80 chars.
  - All other event shapes (incl. `result`) drop — `finalize()` owns the closing UI and `appendFinal` carries the assistant reply.
- **Edit dedupe:** skip `editMessageText` when rendered body equals the last successfully sent body (guards against TG's `message is not modified` error).
- **Deps:** `Sender` (`send`, `edit` with `parseMode: "HTML"`), `setTimeout` (debounce), event renderer.

## 4. Data
- **Entities:**
  - `Config` — deploy-time env-loaded config.
  - `Update` — TG Bot API update (subset: `message.chat.id`, `message.message_thread_id`, `message.text`).
  - `SessionSection` — `{ token: string, updatedAt: string }`.
  - `StoredSettings` — every field optional: `{ model?, effort?, permissionMode?, timeoutSeconds?, maxRetries?, retryDelaySeconds? }`.
- **ERD:** flat; no DB. Single JSON file `.tg-ide-bridge/session.json` with two optional sections: `session` and `settings`. When both are cleared the file is removed.
- **Migration:** legacy flat `{token, updatedAt}` at top level → read as `session` section; next write uses new shape. Automatic, no user action required.

## 5. Logic
- **Algos:**
  - **Long poll loop**: `offset = 0`; request `getUpdates?offset=<offset>&timeout=25`; for each update set `offset = update_id + 1`; on network error, exponential backoff capped at 30 s.
  - **Response chunking** (fallback): if `len(text) <= 4000` send as-is; else split at last `\n` ≤4000 chars; fallback to hard cut at 4000 if no newline.
  - **Live-edit rollover**: per-invocation `LiveHandle` holds `{ messageId, streamBuffer, finalBuffer, lastFlushAt, lastSentText, closed }`. `appendEvent` pushes pre-escaped HTML lines (rendered by the event renderer); `appendOutput` HTML-escapes its raw input first; both then schedule a flush. Stream lines are stored already-escaped so `\n` boundaries are safe rollover cut points. `appendFinal` pushes into `finalBuffer`. Flush renders the full HTML body; if length > `rolloverAt` (default 3800), split `streamBuffer` at last `\n` inside the tag-overhead-adjusted budget, finalize the current message with `\n…`, open a new TG message with the tail. Edits are skipped when `rendered === lastSentText`. On `finalize` the scheduled flush is forced and no further appends are accepted.
  - **Session update**: after IDE invocation, extract new `session_id` from `RuntimeInvokeResult.output`, atomically write to `.tg-ide-bridge/session.json` via temp-file-rename.
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
