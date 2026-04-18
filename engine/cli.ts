/**
 * @module
 * Daemon entrypoint. Wires config (from env) → IDE client → session store →
 * sender → poller → dispatcher. Exits non-zero on startup health-check
 * failure (FR-CONFIG) so operator sees the problem immediately instead of
 * a silent stuck poller.
 *
 * Env vars are loaded at task level via `deno run --env-file=.env`.
 */

import { ConfigError, loadConfig } from "./config.ts";
import { isAllowed } from "./auth.ts";
import { Poller } from "./tg/poller.ts";
import { Sender } from "./tg/sender.ts";
import { Streamer } from "./tg/streamer.ts";
import { Dispatcher } from "./dispatcher.ts";
import { SessionStore } from "./session.ts";
import { getRuntimeAdapter, killAll } from "@korchasa/ai-ide-cli";
import { createLogger, sanitizeError } from "./log.ts";

const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "stop", description: "abort the current IDE call" },
  { command: "reset", description: "clear session token" },
  { command: "settings", description: "show effective settings" },
  { command: "model", description: "set/show IDE model (arg or 'clear')" },
  { command: "effort", description: "set/show reasoning effort (claude)" },
  { command: "perm", description: "set/show permission mode" },
  { command: "timeout", description: "set/show per-invoke timeout (seconds)" },
  { command: "retries", description: "set/show runtime retry attempts" },
  { command: "retry_delay", description: "set/show retry delay (seconds)" },
];

export async function main(_args: string[]): Promise<number> {
  const log = createLogger();

  let cfg;
  try {
    cfg = loadConfig(Deno.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error("config load failed", { err: err.message });
    } else {
      log.error("config load failed", { err: sanitizeError(err) });
    }
    return 1;
  }

  const sender = new Sender(cfg.token);
  const streamer = new Streamer({ sender });
  const poller = new Poller(cfg.token, {
    onError: (err) => log.warn("poller error", { err }),
  });
  const ide = getRuntimeAdapter(cfg.ide);
  const session = new SessionStore(cfg.project_dir);
  const dispatcher = new Dispatcher({
    cfg,
    sender,
    ide,
    session,
    streamer,
    log,
    killRunning: killAll,
  });

  try {
    const me = await sender.getMe();
    log.info("connected to telegram", {
      bot_id: me.id,
      username: me.username,
      project_dir: cfg.project_dir,
      ide: cfg.ide,
    });
  } catch (err) {
    log.error("telegram health check failed", { err: sanitizeError(err) });
    return 1;
  }

  // FR-SETTINGS: register slash-command menu in Telegram clients.
  await sender.setMyCommands(BOT_COMMANDS).catch((err) => {
    log.warn("setMyCommands failed", { err: sanitizeError(err) });
  });

  const controller = new AbortController();
  const onSignal = () => {
    log.info("shutting down");
    controller.abort();
  };
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  try {
    for await (const update of poller.poll(controller.signal)) {
      if (!isAllowed(update, cfg)) {
        log.debug("update rejected by auth", { update_id: update.update_id });
        continue;
      }
      dispatcher.handle(update).catch((err) => {
        log.error("dispatcher handle failed", { err: sanitizeError(err) });
      });
    }
  } finally {
    Deno.removeSignalListener("SIGINT", onSignal);
    Deno.removeSignalListener("SIGTERM", onSignal);
  }
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
