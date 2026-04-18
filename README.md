# tg-ide-bridge

Per-project daemon that bridges a Telegram chat to an AI IDE (Claude Code,
Cursor CLI, OpenCode). Send a message from Telegram, the daemon invokes the
IDE inside your project folder, streams the response back, and preserves
conversation context across messages via `--resume`.

- No public endpoint — the daemon polls Telegram over HTTPS, so it works
  behind NAT with your laptop closed to the world.
- One daemon = one project folder = one chat (or one forum topic).
- Backed by [`jsr:@korchasa/ai-ide-cli`](https://jsr.io/@korchasa/ai-ide-cli),
  so the same daemon works with Claude, OpenCode, and Cursor.

## Requirements

- [Deno](https://deno.com) ≥ 2.
- A Telegram bot token ([BotFather](https://t.me/BotFather) → `/newbot`).
- An AI IDE CLI installed locally (`claude`, `opencode`, or `cursor`).

## Quick start

1. Create a bot with `@BotFather`, add it to the chat or forum topic you
   want to control from, and note the chat ID (`@userinfobot` returns it).
2. Copy the example env file into your project and edit values:

   ```sh
   cp .env.example .env
   ```

3. Run the daemon from your project root:

   ```sh
   deno task prod
   ```

   The daemon's project directory is always the directory `deno task` is
   launched from. On startup it runs a Telegram `getMe` health check — if
   the token is invalid it exits non-zero immediately.
4. Send any message to the bot. The daemon runs your AI IDE with the prompt,
   then streams the response back.

## Telegram commands

Plain text → forwarded as a prompt to the IDE, continuing the current session.

Session:

- `/reset` — clear the persisted session token; next message starts a
  fresh IDE conversation.
- `/stop` — abort the currently running IDE subprocess (SIGTERM, then
  SIGKILL after 5 s). Bypasses the dispatcher queue so it reaches the
  in-flight call. With `/retries > 1` the IDE adapter may auto-relaunch
  between attempts; send `/stop` again after the new attempt starts.

Runtime-tunable IDE settings (persisted in
`.tg-ide-bridge/session.json` alongside the session token):

- `/settings` — show current effective settings.
- `/model [value|clear]` — set or clear the model. Without an argument,
  prints the current value and the whitelist for the configured IDE.
- `/effort [value|clear]` — Claude-only reasoning effort. Forwarded as
  `--effort <value>`. Other IDEs report "not supported".
- `/perm [value|clear]` — permission mode (e.g. `acceptEdits`, `plan`,
  `bypassPermissions`). Cursor reports "not supported".
- `/timeout [seconds|clear]` — per-invocation timeout. Default `600`.
- `/retries [count|clear]` — runtime retry attempts on IDE error. Default `1`.
- `/retry_delay [seconds|clear]` — base delay between retries. Default `2`.

`clear` reverts the field to the built-in default (numeric) or unsets it
(model / effort / permission mode).

On startup the daemon registers these commands via Telegram's
`setMyCommands` so they appear in the `/` menu of all bot clients.

### Whitelists per IDE

- **claude** — models: `sonnet`, `opus`, `haiku`,
  `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-opus-4-5`,
  `claude-opus-4-7`, `claude-haiku-4-5`; efforts: `low`, `medium`, `high`,
  `xhigh`, `max`; permission modes: `default`, `acceptEdits`, `plan`,
  `auto`, `dontAsk`, `bypassPermissions`.
- **opencode** — models: `anthropic/claude-sonnet-4-5`,
  `anthropic/claude-opus-4-5`, `openai/gpt-5`, `google/gemini-2.5-pro`;
  effort not supported; permission modes: `default`, `acceptEdits`,
  `plan`, `bypassPermissions`.
- **cursor** — models: `auto`, `sonnet`, `opus`, `gpt-5`; effort and
  permission mode not supported.

Numeric ranges: `timeoutSeconds` ∈ [1, 3600]; `maxRetries` ∈ [0, 10]
(integer); `retryDelaySeconds` ∈ [0, 60].

## Configuration

Deploy-time config comes from environment variables (loaded from `.env`
by `deno task dev` / `deno task prod`):

- `FLOWAI_TELEGRAM_BOT_TOKEN` (required) — Telegram bot token. Never logged,
  never echoed to chat.
- `FLOWAI_TELEGRAM_CHAT_ID` (required, non-empty) — comma-separated list of
  chat IDs allowed to drive the daemon. All other updates are dropped before
  reaching the IDE.
- `FLOWAI_TELEGRAM_ALLOWED_THREAD_IDS` (optional) — comma-separated list of
  forum topic IDs. When set, only messages posted in one of these topics are
  accepted.
- `FLOWAI_BRIDGE_IDE` (required) — `claude`, `opencode`, or `cursor`.

Runtime IDE parameters (model, effort, permission mode, timeout, retries,
retry delay) are **not** env vars — set them via the Telegram commands
listed above.

## Storage layout

The daemon writes one file:

- `<project_dir>/.tg-ide-bridge/session.json` — JSON document with two
  sections:
  - `session` — IDE `--resume` token and timestamp.
  - `settings` — user-tunable IDE params (only fields the user has set).

Written atomically (temp-file + rename) with POSIX mode `0600`. On Windows
the mode bit is a no-op and the file may be world-readable; prefer WSL or
a per-user directory if that matters.

The legacy flat `{token, updatedAt}` format is auto-migrated on read; the
next write uses the new shape.

`.tg-ide-bridge/` and `.env` are gitignored by default.

## Development

- `deno task dev` — watch mode (auto-loads `.env`).
- `deno task check` — fmt + lint + comment-scan + tests.
- `deno task test` — tests only.

## Limits (v1)

- One in-flight IDE call per daemon. Messages arriving during a long run
  are handled FIFO.
- Long polling only; webhooks deferred.
- No support for Telegram attachments (files, images, voice).
- Single project per daemon. Run multiple daemons for multiple projects.
