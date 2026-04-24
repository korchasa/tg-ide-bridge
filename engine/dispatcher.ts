/**
 * @module
 * Per-update handler. Owns the serialization contract: one in-flight IDE
 * call per daemon. A promise chain ensures overlapping `handle()` calls do
 * not execute `#handleInner` concurrently (FR-CMD-EXEC scope in v1).
 *
 * Also hosts the TG command surface: session (`/reset`), cancel (`/stop`),
 * and runtime-tunable settings (FR-SETTINGS): `/settings`, `/model`,
 * `/effort`, `/perm`, `/timeout`, `/retries`, `/retry_delay`. Settings are
 * persisted via `SessionStore`.
 *
 * `/stop` short-circuits the per-dispatcher queue so it can reach the
 * currently-running IDE subprocess. All other commands serialize normally.
 */

import type { Config, SupportedIde } from "./config.ts";
import type { Sender } from "./tg/sender.ts";
import { chunkText } from "./tg/sender.ts";
import type { Streamer } from "./tg/streamer.ts";
import type { TgUpdate } from "./tg/types.ts";
import { sanitizeError } from "./log.ts";
import type { Logger } from "./log.ts";
import type { ExtraArgsMap, RuntimeAdapter } from "@korchasa/ai-ide-cli";
import type { SessionStore } from "./session.ts";
import { SessionManager } from "./ide_session.ts";
import {
  type EffectiveSettings,
  effectiveSettings,
  formatSettings,
  type StoredSettings,
  validateEffort,
  validateMaxRetries,
  validateModel,
  validatePermissionMode,
  validateRetryDelaySeconds,
  validateTimeoutSeconds,
  type ValidationResult,
  WHITELISTS,
} from "./settings.ts";

export interface DispatcherDeps {
  cfg: Config;
  sender: Sender;
  ide?: RuntimeAdapter;
  session?: SessionStore;
  streamer?: Streamer;
  log: Logger;
  /**
   * Opt-in session-mode manager. When present (and `streamer` is set), turns
   * reuse one long-lived IDE subprocess; otherwise the dispatcher falls back
   * to one-shot `invoke()` per turn. Tests inject a stub; production wires
   * this automatically in `cli.ts` when `ide.capabilities.session` is true.
   */
  sessionManager?: SessionManager;
}

const TYPING_REFRESH_MS = 4_000;

export class Dispatcher {
  readonly #cfg: Config;
  readonly #sender: Sender;
  readonly #ide?: RuntimeAdapter;
  readonly #session?: SessionStore;
  readonly #streamer?: Streamer;
  readonly #log: Logger;
  readonly #sessionManager?: SessionManager;
  #queue: Promise<void> = Promise.resolve();
  #inFlight = 0;
  /** Per-turn abort controller. `/stop` calls `.abort()`; invoke-mode pipes
   * the signal to `ide.invoke`, session-mode pipes it to `SessionManager`. */
  #currentAbortCtrl: AbortController | null = null;

  constructor(deps: DispatcherDeps) {
    this.#cfg = deps.cfg;
    this.#sender = deps.sender;
    this.#ide = deps.ide;
    this.#session = deps.session;
    this.#streamer = deps.streamer;
    this.#log = deps.log;
    this.#sessionManager = deps.sessionManager;
  }

  /** Release session-mode resources on daemon shutdown. */
  async close(): Promise<void> {
    await this.#sessionManager?.close();
  }

  handle(update: TgUpdate): Promise<void> {
    // /stop bypasses the queue so it can abort the currently-running IDE
    // subprocess; otherwise it would serialize behind the very call it is
    // trying to cancel.
    const msg = update.message;
    if (msg?.text?.trim() === "/stop") {
      return this.#handleStop(msg.chat.id, msg.message_thread_id);
    }
    const next = this.#queue.then(() => this.#handleInner(update));
    this.#queue = next.catch(() => {});
    return next;
  }

  async #handleStop(chatId: number, threadId?: number): Promise<void> {
    // FR-SETTINGS: /stop aborts current IDE invocation via AbortSignal.
    // Invoke-mode: the signal short-circuits `ide.invoke` retry loop and
    //   SIGTERMs the subprocess via `ai-ide-cli`.
    // Session-mode: the signal propagates into `SessionManager.runTurn`,
    //   which aborts the session — next turn reopens with the stored id.
    const wasInFlight = this.#inFlight > 0;
    this.#currentAbortCtrl?.abort("stopped by user");
    const reply = wasInFlight ? "IDE call stopped" : "no active IDE call";
    await this.#reply(chatId, threadId, reply);
  }

  async #handleInner(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const text = msg.text;

    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
      if (await this.#tryCommand(chatId, threadId, trimmed)) return;
    }

    if (!this.#ide) {
      await this.#sender.send(chatId, text, threadId).catch((err) => {
        this.#log.error("send failed", { err: sanitizeError(err) });
      });
      return;
    }

    await this.#runIde(chatId, threadId, text);
  }

  /** Returns true if `trimmed` matched a command (handled or rejected). */
  async #tryCommand(
    chatId: number,
    threadId: number | undefined,
    trimmed: string,
  ): Promise<boolean> {
    // FR-SETTINGS
    const [head, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (head) {
      case "/reset":
        await this.#handleReset(chatId, threadId);
        return true;
      case "/settings":
        await this.#handleShowSettings(chatId, threadId);
        return true;
      case "/model":
        await this.#handleEnumSetting(
          chatId,
          threadId,
          "model",
          arg,
          (v) => validateModel(this.#cfg.ide, v),
          WHITELISTS[this.#cfg.ide].models,
        );
        return true;
      case "/effort":
        await this.#handleEnumSetting(
          chatId,
          threadId,
          "effort",
          arg,
          (v) => validateEffort(this.#cfg.ide, v),
          WHITELISTS[this.#cfg.ide].efforts,
        );
        return true;
      case "/perm":
        await this.#handleEnumSetting(
          chatId,
          threadId,
          "permissionMode",
          arg,
          (v) => validatePermissionMode(this.#cfg.ide, v),
          WHITELISTS[this.#cfg.ide].permissionModes,
        );
        return true;
      case "/timeout":
        await this.#handleNumericSetting(
          chatId,
          threadId,
          "timeoutSeconds",
          arg,
          validateTimeoutSeconds,
        );
        return true;
      case "/retries":
        await this.#handleNumericSetting(
          chatId,
          threadId,
          "maxRetries",
          arg,
          validateMaxRetries,
        );
        return true;
      case "/retry_delay":
        await this.#handleNumericSetting(
          chatId,
          threadId,
          "retryDelaySeconds",
          arg,
          validateRetryDelaySeconds,
        );
        return true;
    }
    return false;
  }

  async #handleReset(chatId: number, threadId?: number): Promise<void> {
    if (this.#sessionManager) {
      await this.#sessionManager.reset();
    }
    if (this.#session) {
      await this.#session.resetSession();
    }
    await this.#reply(chatId, threadId, "session cleared");
  }

  async #handleShowSettings(
    chatId: number,
    threadId: number | undefined,
  ): Promise<void> {
    const stored = await this.#loadStoredSettings();
    await this.#reply(chatId, threadId, formatSettings(this.#cfg.ide, stored));
  }

  async #handleEnumSetting(
    chatId: number,
    threadId: number | undefined,
    field: "model" | "effort" | "permissionMode",
    arg: string,
    validate: (v: string) => ValidationResult<string>,
    allowed: readonly string[],
  ): Promise<void> {
    if (arg === "") {
      const stored = await this.#loadStoredSettings();
      const cur = stored[field] ?? "—";
      const list = allowed.length > 0
        ? `allowed: ${allowed.join(", ")}`
        : `not supported for ide '${this.#cfg.ide}'`;
      await this.#reply(chatId, threadId, `${field}: ${cur}\n${list}`);
      return;
    }
    if (!this.#session) {
      await this.#reply(chatId, threadId, "session store not configured");
      return;
    }
    if (arg === "clear") {
      await this.#session.saveSettings({ [field]: undefined });
      await this.#reply(chatId, threadId, `${field} cleared`);
      return;
    }
    const res = validate(arg);
    if (!res.ok) {
      await this.#reply(chatId, threadId, res.error);
      return;
    }
    await this.#session.saveSettings({ [field]: res.value });
    await this.#reply(chatId, threadId, `${field} set: ${res.value}`);
  }

  async #handleNumericSetting(
    chatId: number,
    threadId: number | undefined,
    field: "timeoutSeconds" | "maxRetries" | "retryDelaySeconds",
    arg: string,
    validate: (v: string) => ValidationResult<number>,
  ): Promise<void> {
    if (arg === "") {
      const stored = await this.#loadStoredSettings();
      const eff = effectiveSettings(stored);
      const cur = stored[field];
      const marker = cur === undefined ? " (default)" : "";
      await this.#reply(
        chatId,
        threadId,
        `${field}: ${eff[field]}${marker}`,
      );
      return;
    }
    if (!this.#session) {
      await this.#reply(chatId, threadId, "session store not configured");
      return;
    }
    if (arg === "clear") {
      await this.#session.saveSettings({ [field]: undefined });
      await this.#reply(chatId, threadId, `${field} cleared`);
      return;
    }
    const res = validate(arg);
    if (!res.ok) {
      await this.#reply(chatId, threadId, res.error);
      return;
    }
    await this.#session.saveSettings({ [field]: res.value });
    await this.#reply(chatId, threadId, `${field} set: ${res.value}`);
  }

  async #reply(
    chatId: number,
    threadId: number | undefined,
    text: string,
  ): Promise<void> {
    await this.#sender.send(chatId, text, threadId).catch((err) => {
      this.#log.error("send failed", { err: sanitizeError(err) });
    });
  }

  async #loadStoredSettings(): Promise<StoredSettings> {
    if (!this.#session) return {};
    return await this.#session.loadSettings();
  }

  async #runIde(
    chatId: number,
    threadId: number | undefined,
    text: string,
  ): Promise<void> {
    const eff = effectiveSettings(await this.#loadStoredSettings());
    const ctrl = new AbortController();
    this.#currentAbortCtrl = ctrl;
    this.#inFlight++;
    try {
      if (this.#sessionManager && this.#streamer) {
        await this.#runSessionStreamed(chatId, threadId, text, eff, ctrl);
        return;
      }
      if (this.#streamer) {
        await this.#runIdeStreamed(chatId, threadId, text, eff, ctrl);
        return;
      }
      await this.#runIdeBatched(chatId, threadId, text, eff, ctrl);
    } finally {
      this.#inFlight--;
      if (this.#currentAbortCtrl === ctrl) this.#currentAbortCtrl = null;
    }
  }

  /** Session-mode streaming path: one long-lived IDE subprocess, events
   * demultiplexed per turn via `SessionManager`. */
  async #runSessionStreamed(
    chatId: number,
    threadId: number | undefined,
    text: string,
    eff: EffectiveSettings,
    ctrl: AbortController,
  ): Promise<void> {
    const manager = this.#sessionManager!;
    const streamer = this.#streamer!;
    const live = await streamer.open(chatId, threadId);
    try {
      await manager.runTurn({
        live,
        text,
        settings: eff,
        stopSignal: ctrl.signal,
      });
    } catch (err) {
      this.#log.error("session run failed", { err: sanitizeError(err) });
      await live.finalize("error", sanitizeError(err)).catch(() => {});
    }
  }

  // FR-EVENT-STREAM
  async #runIdeStreamed(
    chatId: number,
    threadId: number | undefined,
    text: string,
    eff: EffectiveSettings,
    ctrl: AbortController,
  ): Promise<void> {
    const ide = this.#ide!;
    const streamer = this.#streamer!;
    let resume: string | null = null;
    if (this.#session) resume = await this.#session.loadSession();
    const live = await streamer.open(chatId, threadId);
    try {
      const extraArgs = effortToExtraArgs(this.#cfg.ide, eff.effort);
      const res = await ide.invoke({
        taskPrompt: text,
        resumeSessionId: resume ?? undefined,
        cwd: this.#cfg.project_dir,
        timeoutSeconds: eff.timeoutSeconds,
        maxRetries: eff.maxRetries,
        retryDelaySeconds: eff.retryDelaySeconds,
        permissionMode: eff.permissionMode,
        model: eff.model,
        extraArgs,
        signal: ctrl.signal,
        onEvent: (event) => live.appendEvent(event),
      });
      if (!res.output) {
        await live.finalize(
          "error",
          sanitizeError(res.error ?? "(no detail)"),
        );
        return;
      }
      if (res.output.is_error) {
        const detail = res.output.result.length > 0
          ? res.output.result
          : (res.error ?? "(no detail)");
        await live.finalize("error", sanitizeError(detail));
        return;
      }
      if (this.#session) {
        if (res.output.session_id && res.output.session_id.length > 0) {
          await this.#session.saveSession(res.output.session_id);
        } else {
          this.#log.warn("ide returned empty session_id; keeping prior token");
        }
      }
      if (res.output.result.length > 0) {
        live.appendFinal(res.output.result);
      }
      await live.finalize("ok");
    } catch (err) {
      this.#log.error("dispatcher run failed", { err: sanitizeError(err) });
      await live.finalize("error", sanitizeError(err)).catch(() => {});
    }
  }

  async #runIdeBatched(
    chatId: number,
    threadId: number | undefined,
    text: string,
    eff: EffectiveSettings,
    ctrl: AbortController,
  ): Promise<void> {
    const ide = this.#ide!;
    const typing = this.#startTyping(chatId, threadId);
    let resume: string | null = null;
    if (this.#session) resume = await this.#session.loadSession();
    try {
      // FR-CMD-EXEC
      const extraArgs = effortToExtraArgs(this.#cfg.ide, eff.effort);
      const res = await ide.invoke({
        taskPrompt: text,
        resumeSessionId: resume ?? undefined,
        cwd: this.#cfg.project_dir,
        timeoutSeconds: eff.timeoutSeconds,
        maxRetries: eff.maxRetries,
        retryDelaySeconds: eff.retryDelaySeconds,
        permissionMode: eff.permissionMode,
        model: eff.model,
        extraArgs,
        signal: ctrl.signal,
      });
      if (!res.output) {
        await this.#sender.send(
          chatId,
          `IDE error: ${sanitizeError(res.error ?? "(no detail)")}`,
          threadId,
        );
        return;
      }
      if (res.output.is_error) {
        const detail = res.output.result.length > 0
          ? res.output.result
          : (res.error ?? "(no detail)");
        await this.#sender.send(
          chatId,
          `IDE error: ${sanitizeError(detail)}`,
          threadId,
        );
        return;
      }
      if (this.#session) {
        if (res.output.session_id && res.output.session_id.length > 0) {
          await this.#session.saveSession(res.output.session_id);
        } else {
          this.#log.warn("ide returned empty session_id; keeping prior token");
        }
      }
      const output = res.output.result.length > 0
        ? res.output.result
        : "(empty response)";
      for (const chunk of chunkText(output)) {
        await this.#sender.send(chatId, chunk, threadId);
      }
    } catch (err) {
      this.#log.error("dispatcher run failed", { err: sanitizeError(err) });
      await this.#sender.send(
        chatId,
        `IDE invocation failed: ${sanitizeError(err)}`,
        threadId,
      ).catch(() => {});
    } finally {
      typing.stop();
    }
  }

  #startTyping(chatId: number, threadId?: number): { stop: () => void } {
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      this.#sender.sendChatAction(chatId, "typing", threadId).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, TYPING_REFRESH_MS);
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }
}

// Claude Code accepts reasoning effort via `--effort`; other runtimes have no
// equivalent flag in `ai-ide-cli` and would reject it.
function effortToExtraArgs(
  ide: SupportedIde,
  effort?: string,
): ExtraArgsMap | undefined {
  if (!effort) return undefined;
  if (ide !== "claude") return undefined;
  return { "--effort": effort };
}
