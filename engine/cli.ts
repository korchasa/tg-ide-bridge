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
import { getRuntimeAdapter } from "@korchasa/ai-ide-cli";
import { SessionManager } from "./ide_session.ts";
import { createLogger, sanitizeError } from "./log.ts";
import {
  type BotCommand,
  DefaultCapabilityProvider,
  loadRegistry,
  mergeCommandList,
} from "./capabilities.ts";

const BOT_COMMANDS: ReadonlyArray<BotCommand> = [
  { command: "stop", description: "abort the current IDE call" },
  { command: "reset", description: "clear session token" },
  { command: "settings", description: "show effective settings" },
  { command: "model", description: "set/show IDE model (arg or 'clear')" },
  { command: "effort", description: "set/show reasoning effort (claude)" },
  { command: "perm", description: "set/show permission mode" },
  { command: "timeout", description: "set/show per-invoke timeout (seconds)" },
  { command: "retries", description: "set/show runtime retry attempts" },
  { command: "retry_delay", description: "set/show retry delay (seconds)" },
  { command: "refresh", description: "rediscover IDE skills/commands" },
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
  const session = new SessionStore(cfg.project_dir, cfg.ide);
  const sessionManager = ide.capabilities.session && ide.openSession
    ? new SessionManager({
      ide,
      ideId: cfg.ide,
      cwd: cfg.project_dir,
      store: session,
      log,
    })
    : undefined;
  // FR-CAPABILITY-INVENTORY: load cached registry; provider exposes refresh.
  const cachedRegistry = await loadRegistry(cfg.project_dir);
  const capabilities = new DefaultCapabilityProvider({
    ide,
    sender,
    projectDir: cfg.project_dir,
    cwd: cfg.project_dir,
    reserved: BOT_COMMANDS,
    initial: cachedRegistry,
  });
  const dispatcher = new Dispatcher({
    cfg,
    sender,
    ide,
    session,
    streamer,
    sessionManager,
    capabilities,
    log,
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

  // FR-SETTINGS + FR-CAPABILITY-INVENTORY: register slash-command menu;
  // merge reserved commands with cached IDE capabilities (if any).
  await sender.setMyCommands(mergeCommandList(BOT_COMMANDS, cachedRegistry))
    .catch((err) => {
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
    await dispatcher.close().catch((err) => {
      log.warn("dispatcher close failed", { err: sanitizeError(err) });
    });
  }
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
