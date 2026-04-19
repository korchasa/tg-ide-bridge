# SRS

## 1. Intro
- **Desc:** `tg-ide-bridge` is a per-project daemon that relays Telegram messages to an AI IDE (Claude Code, Cursor, OpenCode, Gemini, etc.) executing in the project's working directory, and streams IDE responses back to the same Telegram chat. Conversation context is preserved across messages via the IDE's `--resume` mechanism.
- **Def/Abbr:**
  - `AI IDE` — AI coding assistant with a CLI (Claude Code, Cursor CLI, OpenCode, Gemini CLI, etc.).
  - `TG` — Telegram.
  - `Bot API` — Telegram Bot HTTP API.
  - `Session` — continuous AI IDE conversation identified by a `--resume` token.
  - `Daemon` — long-running Deno process bound to one project folder and one TG chat.
  - `ai-ide-cli` — `jsr:@korchasa/ai-ide-cli`, uniform CLI wrapper over multiple AI IDEs.

## 2. General
- **Context:** Power users of AI IDEs want to continue conversations with their coding assistant while away from the laptop. Existing setups require the IDE's GUI or local terminal. `tg-ide-bridge` exposes the IDE through Telegram while keeping the IDE process on the user's machine — no public endpoint, no SaaS relay.
- **Assumptions/Constraints:**
  - Deno runtime available on host.
  - `ai-ide-cli` binary installed and configured for at least one AI IDE backend.
  - User has a TG Bot token and a private chat or topic the bot is a member of.
  - One daemon instance per project folder; no multi-project routing in v1.
  - Long-polling only; webhooks out of scope for v1.
  - English documentation; no localization.

## 3. Functional Reqs

### 3.1 FR-TG-POLL
- **Desc:** Daemon polls TG Bot API via long polling and receives messages from the configured chat.
- **Scenario:** Daemon starts → authenticates with bot token → enters long-poll loop → ignores updates from other chats.
- **Acceptance:**
  - [x] Daemon survives transient TG API errors (retries with backoff). Evidence: test `engine/tg/poller_test.ts::Poller backs off exponentially on network error` + `…caps backoff at 30s`; code `// FR-TG-POLL` in `engine/tg/poller.ts`.
  - [x] Only messages from the whitelisted chat/topic are processed. Evidence: code `// FR-AUTH` in `engine/auth.ts`; `engine/cli.ts` filters via `isAllowed` before `dispatcher.handle`; tests `engine/auth_test.ts`.

### 3.2 FR-CMD-EXEC
- **Desc:** Each accepted TG message is passed as a prompt to the AI IDE via `ai-ide-cli` in the project's cwd.
- **Scenario:** Message received → daemon invokes `ai-ide-cli` with prompt + current `--resume` token (if any) → captures stdout/stderr → posts response to same chat.
- **Acceptance:**
  - [x] cwd of the IDE subprocess equals the project folder the daemon was launched in. Evidence: code `// FR-CMD-EXEC` in `engine/dispatcher.ts`; test `engine/dispatcher_test.ts::Dispatcher invokes IDE and chunks output back to chat` asserts `cwd` on `IdeClient.invoke`.
  - [x] Non-zero exit from `ai-ide-cli` is reported to the chat with the error. Evidence: test `engine/dispatcher_test.ts::Dispatcher reports IDE error to chat`.

### 3.3 FR-SESSION-RESUME
- **Desc:** Daemon persists the IDE session token across messages and restarts so follow-up messages continue the same conversation.
- **Scenario:** First message → new IDE session → token saved to disk. Subsequent messages → `--resume <token>`. Daemon restart → token reloaded from disk.
- **Acceptance:**
  - [x] Session token persisted on disk (atomic write). Evidence: code `// FR-SESSION-RESUME` in `engine/session.ts` (`SessionStore.save` uses temp + rename + chmod 0600); tests `engine/session_test.ts::SessionStore.save survives rename failure without leaving tmp` and `…writes file with mode 0600 (POSIX)`.
  - [x] After daemon restart, next message resumes the previous conversation (not a new one). Evidence: test `engine/dispatcher_test.ts::Dispatcher persists session token and resumes on next call` — second `IdeClient.invoke` receives `resume` = token persisted in the first call (equivalent to a restart via `SessionStore.load`).
  - [x] User can reset the session via a TG command (e.g., `/reset`). Evidence: test `engine/dispatcher_test.ts::Dispatcher /reset clears session and next call omits resume`.

### 3.4 FR-RESPONSE-STREAM
- **Desc:** IDE responses are posted back to the originating chat, split across TG messages if they exceed TG's 4096-char limit.
- **Scenario:** IDE writes long response → daemon chunks by 4000 chars on newline boundaries → sends sequentially.
- **Acceptance:**
  - [x] No response is truncated silently. Evidence: code `// FR-RESPONSE-STREAM` in `engine/tg/sender.ts` (`chunkText`); tests `engine/tg/sender_test.ts::chunkText is lossless for mixed content` and `…hard-cuts when no newline in window`.
  - [x] Chunk boundaries prefer newlines over mid-line cuts. Evidence: test `engine/tg/sender_test.ts::chunkText splits on newline when available in window`.

### 3.5 FR-AUTH
- **Desc:** Only messages from whitelisted chat IDs (and optional topic IDs) are accepted.
- **Scenario:** Daemon config lists allowed chat IDs → updates from other chats are dropped with a debug log.
- **Acceptance:**
  - [x] Config field `allowed_chat_ids` (required, non-empty). Evidence: code `// FR-CONFIG` in `engine/config.ts` (`requireNumberArray` + non-empty check); test `engine/config_test.ts::loadConfig rejects empty allowed_chat_ids`.
  - [x] Unauthorized updates never reach `ai-ide-cli`. Evidence: code `// FR-AUTH` in `engine/auth.ts`; `engine/cli.ts` applies `isAllowed` before `dispatcher.handle`; tests `engine/auth_test.ts::isAllowed rejects non-whitelisted chat` and `…enforces thread whitelist when configured`.

### 3.6 FR-EVENT-STREAM
- **Desc:** Daemon streams IDE events (tool calls, thinking, partial output) and the final result to TG in near-real-time using a single "live" TG message that is edited as events arrive. When the live message approaches TG's 4096-char limit, it is finalized and a new live message opens. Hybrid approach: silent (edits do not push notifications) + unbounded length via rollover. Rendering uses `parse_mode: "HTML"`: stream events go inside a `<blockquote expandable>…</blockquote>` (collapsible); the final assistant result is plain text underneath. The `[stream]` prefix emitted by `@korchasa/ai-ide-cli` is stripped.
- **Scenario:** Message accepted → daemon opens live TG message with a placeholder → subscribes to `onEvent`/`onOutput` from `@korchasa/ai-ide-cli` → appends rendered events to an in-memory stream buffer (prefix stripped, HTML-escaped) → edits live message (debounced to respect ≤1 edit/sec per chat) → at ~3800 rendered chars the current live message is finalized (terminal marker appended) and a fresh live message opens → on IDE completion the final result is appended to a separate final-text buffer rendered below the blockquote and the last live message is finalized.
- **Acceptance:**
  - [x] Edits are debounced so bursts coalesce into one `editMessageText` per debounce window. Evidence: code `// FR-EVENT-STREAM` in `engine/tg/streamer.ts` (`#scheduleFlush`); tests `engine/tg/streamer_test.ts::LiveHandle.appendOutput triggers single edit after debounce` and `…coalesces bursts into at most one edit per second`.
  - [x] Sustained edit rate to one chat is bounded by `minEditIntervalMs` (default 1000 ms) so TG's per-chat limit is respected. Evidence: same `…coalesces bursts into at most one edit per second` test asserts ≥1 s between consecutive edits; default in `engine/tg/streamer.ts::DEFAULT_MIN_EDIT_MS`.
  - [x] Live message rolls over before reaching 4096 chars; no content is lost across the boundary. Evidence: code `// FR-EVENT-STREAM: rollover` in `engine/tg/streamer.ts::#rollover`; test `engine/tg/streamer_test.ts::LiveHandle rolls over to new message when buffer exceeds limit`.
  - [x] On successful completion the last live message is finalized without a trailing success marker (clean stream + final answer only). Evidence: `engine/tg/streamer.ts::finalize` with empty marker for `kind === "ok"`; test `engine/tg/streamer_test.ts::LiveHandle.finalize(ok) flushes content without a trailing success marker`.
  - [x] On IDE error the live message is finalized with `✗ <detail>`. Evidence: `engine/tg/streamer.ts::ERR_PREFIX`; tests `engine/tg/streamer_test.ts::LiveHandle.finalize(error) appends error trailer` and `engine/dispatcher_test.ts::Dispatcher finalizes live message with ✗ on IDE error`.
  - [x] `Dispatcher` pipes `onEvent` from `ai-ide-cli` into the live message via `LiveHandle.appendEvent` (rich renderer), with a fallback batched path when no `Streamer` is configured. `onOutput` is intentionally not wired — the rich renderer covers the same content and dual wiring would duplicate every line. Evidence: code `// FR-EVENT-STREAM` in `engine/dispatcher.ts::#runIdeStreamed`; test `engine/dispatcher_test.ts::Dispatcher streams onEvent through Streamer to TG edits`.
  - [x] Stream lines render with operation-type emoji and `<code>`-wrapped arguments for known IDE tools (Read 📖, Write 📝, Edit ✏️, Bash 🐚, Grep 🔍, Glob 📁, Agent 🤖, WebFetch 🌐, WebSearch 🔎, TodoWrite 📋, NotebookEdit 📓; default 🛠️); assistant text blocks render with 💬; `system/init` renders with ⚙️ and the model name. All argument values are HTML-escaped and truncated to 80 chars. Evidence: `renderEvent`/`fmtToolDetail`/`TOOL_EMOJI` in `engine/tg/streamer.ts`; tests `engine/tg/streamer_test.ts::LiveHandle.appendEvent renders Read tool with 📖 emoji and <code>-wrapped path`, `…renders Bash with description fallback`, `…renders Bash command in <code> when no description`, `…renders Grep with pattern and path`, `…renders text block with 💬 emoji`, `…renders system init with model`, `…uses fallback emoji for unknown tool`, `…escapes HTML in tool input`, `…skips unknown event types`.
  - [x] Stream events render inside `<blockquote expandable>…</blockquote>` with `[stream]` prefix stripped; final result renders as plain escaped text outside the blockquote; all API calls from the streamer carry `parse_mode: "HTML"`. Evidence: code `// FR-EVENT-STREAM` in `engine/tg/streamer.ts` (`#render`, `stripStreamPrefix`, `BQ_OPEN`/`BQ_CLOSE`, `PARSE_MODE`); tests `engine/tg/streamer_test.ts::Streamer sends every API call with parse_mode: HTML`, `…strips [stream] prefix from onOutput lines`, `…wraps stream buffer inside <blockquote expandable>`, `…HTML-escapes <, >, & in stream content`, `…appendFinal renders final text outside the blockquote`; `engine/dispatcher.ts` routes `res.output.result` via `live.appendFinal`.
  - [x] Streamer skips an `editMessageText` call when the rendered body is unchanged (guards against `message is not modified`). Evidence: code `// FR-EVENT-STREAM` in `engine/tg/streamer.ts::#flush` (`rendered === #lastSentText` guard).

### 3.7 FR-CONFIG
- **Desc:** Deploy-time config comes from environment variables only. Scope is intentionally narrow: bot identity, chat whitelist, IDE selection. The project directory equals the working directory `deno task` is launched from — there is no env var for it. Runtime-tunable IDE params (model/effort/permission mode/timeout/retries/retry delay) are NOT here; see FR-SETTINGS.
- **Scenario:** Startup reads `FLOWAI_TELEGRAM_BOT_TOKEN`, `FLOWAI_TELEGRAM_CHAT_ID`, `FLOWAI_BRIDGE_IDE` (and optional `FLOWAI_TELEGRAM_ALLOWED_THREAD_IDS`) from the process environment.
- **Acceptance:**
  - [x] Missing token → daemon exits with clear error. Evidence: test `engine/config_test.ts::loadConfig throws when token missing`; `engine/cli.ts::main` catches `ConfigError` and returns exit code 1.
  - [x] Env schema validated at startup; invalid env → exit. Evidence: tests `engine/config_test.ts::loadConfig rejects invalid ide`, `…rejects missing allowed_chat_ids`, `…rejects non-numeric chat id`.
  - [x] Runtime IDE tuning env vars are ignored (settings now live in session.json via FR-SETTINGS). Evidence: test `engine/config_test.ts::loadConfig ignores removed IDE tuning env vars`.

### 3.8 FR-SETTINGS
- **Desc:** User-tunable IDE parameters (`model`, `effort`, `permissionMode`, `timeoutSeconds`, `maxRetries`, `retryDelaySeconds`) are controlled from Telegram and persisted in `.tg-ide-bridge/session.json`. Values apply to every subsequent IDE invocation until changed or cleared. Each IDE has a whitelist for enum-like fields; numeric fields have bounded ranges.
- **Scenario:** User sends `/model opus` → daemon validates against the whitelist for the configured IDE, stores the value, and replies `model set: opus`. Next plain message runs the IDE with `model=opus`. `/model clear` unsets the override; `/model` (no arg) prints current value + allowed list. `/settings` prints all effective values, marking fields that fall back to the built-in default.
- **Acceptance:**
  - [x] `/settings` shows effective values and marks defaults. Evidence: test `engine/dispatcher_test.ts::Dispatcher /settings prints effective settings`; `engine/settings.ts::formatSettings`.
  - [x] `/model <value>`, `/effort <value>`, `/perm <value>` validate against per-IDE whitelists and reject unknown values without mutating state. Evidence: tests `…Dispatcher /model opus stores setting`, `…Dispatcher /model with invalid value rejects and preserves state`, `…Dispatcher /effort on opencode reports not supported`.
  - [x] `/timeout`, `/retries`, `/retry_delay` validate numeric ranges; rejects on boundary violations. Evidence: tests `…Dispatcher /timeout 42 stores numeric setting`, `…Dispatcher /timeout 0 is rejected with clear error`.
  - [x] Bot slash-menu registered via `setMyCommands` at startup. Evidence: code `// FR-SETTINGS` in `engine/cli.ts` (`BOT_COMMANDS` + `sender.setMyCommands`); test `engine/tg/sender_test.ts::Sender.setMyCommands posts to setMyCommands with commands array`.
  - [x] `/stop` aborts the currently-running IDE subprocess. Bypasses the dispatcher queue so it is not serialized behind the call it is trying to cancel. Wires `killAll` from `@korchasa/ai-ide-cli`'s process registry (SIGTERM → 5 s grace → SIGKILL). Evidence: code `// FR-SETTINGS` in `engine/dispatcher.ts::#handleStop`; `engine/cli.ts::main` passes `killRunning: killAll`; tests `engine/dispatcher_test.ts::Dispatcher /stop replies 'no active IDE call' when idle`, `…Dispatcher /stop bypasses queue and kills running invocation`.
  - [x] `clear` argument unsets the field (reverts to default). Evidence: tests `…Dispatcher /model clear unsets the field`, `…Dispatcher /retries clear resets to default`.
  - [x] Settings take effect on the next IDE invocation without daemon restart. Evidence: test `…Dispatcher command changes take effect on next IDE call`.
  - [x] Stored settings survive daemon restart (same persistence mechanism as FR-SESSION-RESUME). Evidence: code `// FR-SETTINGS` in `engine/session.ts::saveSettings`; tests `engine/session_test.ts::SessionStore.saveSettings merges patch into stored settings`, `…SessionStore session and settings coexist in one file`.
  - [x] Legacy flat `{token, updatedAt}` session file is auto-migrated on read. Evidence: test `engine/session_test.ts::SessionStore migrates legacy flat {token, updatedAt} format`.

## 4. Non-Functional
- **Perf/Reliability/Sec/Scale/UX:**
  - **Perf**: message→response latency dominated by IDE itself; daemon overhead <200 ms per message. Event→live-edit latency ≤2 s on a quiet chat (bounded by TG's 1 edit/sec per-chat limit).
  - **Reliability**: transient TG/API errors retried with exponential backoff; daemon does not crash on single-message failure.
  - **Sec**: bot token in env only; never logged; never echoed to chat. Unauthorized chats strictly rejected. Command output is displayed verbatim — user is responsible for not sending commands that dump secrets.
  - **Scale**: one daemon = one project = one chat. Multi-tenant out of scope.
  - **UX**: user experience is "TG chat with the AI IDE". Supported slash commands: `/reset`, `/stop`, `/settings`, `/model`, `/effort`, `/perm`, `/timeout`, `/retries`, `/retry_delay`. Registered via `setMyCommands` at startup so they appear in the TG client's `/` menu.

## 5. Interfaces
- **API/Proto/UI:**
  - **Telegram Bot API** (long polling, HTTPS).
  - **`ai-ide-cli` subprocess** (stdout/stderr capture, exit code).
  - **Local filesystem**: session token file under the project's `.tg-ide-bridge/` directory.
  - **Configuration**: environment variables only (loaded from `.env` by the `deno task` runner). No config file.
  - **UI**: Telegram chat only — no web/GUI.

## 6. Acceptance
- **Criteria:**
  - [x] Daemon starts in a project folder, connects to TG, responds to a test message routed through the configured AI IDE, and preserves session across a restart. Evidence: `engine/cli.ts::main` wires config → `Sender.getMe` health check → `Poller` → `Dispatcher` with `SessionStore`; tests `engine/dispatcher_test.ts::Dispatcher invokes IDE and chunks output back to chat` (message → IDE → chat) and `…persists session token and resumes on next call` (restart-equivalent resume via `SessionStore` load/save); manual smoke documented in `README.md`.
  - [x] Unauthorized chats cannot trigger commands. Evidence: tests in `engine/auth_test.ts` (`isAllowed` semantics) — `engine/cli.ts` applies `isAllowed` as a hard gate before every `dispatcher.handle`.
  - [x] `check` passes (fmt, lint, tests). Evidence: `deno task check` executes `scripts/check.ts` (fmt, lint, comment-scan, tests) and reports green.
