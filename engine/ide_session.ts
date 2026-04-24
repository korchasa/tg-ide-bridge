/**
 * @module
 * Long-lived IDE session manager. Wraps `ai-ide-cli`'s `RuntimeAdapter.openSession`
 * and demultiplexes one event stream into per-turn `LiveHandle`s.
 *
 * A "turn" = one user message + streamed IDE events + final assistant reply.
 * `SYNTHETIC_TURN_END` (emitted by every adapter in 0.5.1+) is the neutral
 * turn-boundary signal — no per-runtime branches.
 *
 * Lifecycle:
 * - First `runTurn` opens the session with `resumeSessionId` from `SessionStore`.
 * - Each subsequent `runTurn` reuses the same subprocess — that's the whole point.
 * - Setting snapshot (model/effort/permissionMode) is captured at open time.
 *   Settings change → `#closeSession` + reopen with captured `sessionId`.
 * - `/stop` aborts the session (session dies; next turn reopens with the saved id).
 * - `/reset` aborts + clears the persisted id (next turn = fresh conversation).
 *
 * Contract: Dispatcher serializes `runTurn` calls. Manager assumes one turn at a
 * time and does not add its own locking. Event drain is a background task; it
 * routes events to `#currentTurn` while one is set, otherwise discards.
 *
 * Per-turn timeouts / retries are not supported (session has no such concept in
 * `ai-ide-cli`). Users cancel via `/stop` (AbortSignal).
 */

import {
  type ExtraArgsMap,
  extractSessionContent,
  type RuntimeAdapter,
  type RuntimeSession,
  type RuntimeSessionEvent,
  SYNTHETIC_TURN_END,
} from "@korchasa/ai-ide-cli";
import type { SupportedIde } from "./config.ts";
import type { Logger } from "./log.ts";
import { sanitizeError } from "./log.ts";
import type { SessionStore } from "./session.ts";
import type { EffectiveSettings } from "./settings.ts";
import type { LiveHandle } from "./tg/streamer.ts";

interface SessionSnapshot {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

function sameSnapshot(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return a.model === b.model && a.effort === b.effort &&
    a.permissionMode === b.permissionMode;
}

interface TurnOutcome {
  finalText: string;
  isError: boolean;
  errorDetail?: string;
  stopped?: boolean;
}

interface TurnContext {
  live: LiveHandle;
  /** Overwritten on each new `assistant` event — the last wins; fallback when
   * the turn-end payload lacks a `result` field. */
  lastAssistantText: string;
  done: PromiseWithResolvers<TurnOutcome>;
}

export interface SessionManagerDeps {
  ide: RuntimeAdapter;
  ideId: SupportedIde;
  cwd: string;
  store?: SessionStore;
  log: Logger;
}

export interface RunTurnOptions {
  live: LiveHandle;
  text: string;
  settings: EffectiveSettings;
  stopSignal: AbortSignal;
}

export class SessionManager {
  readonly #ide: RuntimeAdapter;
  readonly #ideId: SupportedIde;
  readonly #cwd: string;
  readonly #store?: SessionStore;
  readonly #log: Logger;

  #session: RuntimeSession | null = null;
  #snapshot: SessionSnapshot | null = null;
  #drainTask: Promise<void> | null = null;
  #currentTurn: TurnContext | null = null;
  #sessionAbort: AbortController | null = null;
  #persistedSessionId = "";
  #stoppedByUser = false;
  /** Serializes persist writes and lets `close()` wait for in-flight writes. */
  #persistChain: Promise<void> = Promise.resolve();
  /** Ring-buffered stderr captured from the IDE subprocess; used to enrich
   * `type:"error"` events whose summary ("send exited with code 1") hides
   * the actual cause. Bounded so a noisy runtime cannot blow memory. */
  #stderrTail = "";

  constructor(deps: SessionManagerDeps) {
    if (!deps.ide.capabilities.session || !deps.ide.openSession) {
      throw new Error(
        `ide '${deps.ideId}' does not advertise session capability`,
      );
    }
    this.#ide = deps.ide;
    this.#ideId = deps.ideId;
    this.#cwd = deps.cwd;
    this.#store = deps.store;
    this.#log = deps.log;
  }

  get hasActiveSession(): boolean {
    return this.#session !== null;
  }

  /**
   * Run one turn. Opens (or reopens on settings change) the session, sends the
   * user text, waits for a `SYNTHETIC_TURN_END` event, and finalizes the live
   * TG message. On abort, aborts the underlying session — next turn reopens
   * with the captured `sessionId`.
   */
  // FR-CMD-EXEC, FR-EVENT-STREAM, FR-SESSION-RESUME
  async runTurn(opts: RunTurnOptions): Promise<void> {
    const desired: SessionSnapshot = {
      model: opts.settings.model,
      effort: opts.settings.effort,
      permissionMode: opts.settings.permissionMode,
    };
    if (
      this.#session && this.#snapshot && !sameSnapshot(this.#snapshot, desired)
    ) {
      this.#log.debug("session: settings changed, reopening");
      await this.#closeSession();
    }
    if (!this.#session) {
      await this.#openSession(desired);
    }
    const turn: TurnContext = {
      live: opts.live,
      lastAssistantText: "",
      done: Promise.withResolvers<TurnOutcome>(),
    };
    this.#currentTurn = turn;
    const onStop = () => {
      this.#stoppedByUser = true;
      this.#sessionAbort?.abort("stopped by user");
    };
    opts.stopSignal.addEventListener("abort", onStop);
    try {
      try {
        await this.#session!.send(opts.text);
      } catch (err) {
        turn.done.resolve({
          finalText: "",
          isError: true,
          errorDetail: sanitizeError(err),
        });
      }
      const outcome = await turn.done.promise;
      if (outcome.isError) {
        await opts.live.finalize(
          "error",
          outcome.errorDetail ?? "(no detail)",
        );
        return;
      }
      if (outcome.finalText.length > 0) {
        opts.live.appendFinal(outcome.finalText);
      }
      await opts.live.finalize("ok");
    } finally {
      opts.stopSignal.removeEventListener("abort", onStop);
      this.#currentTurn = null;
    }
  }

  /** Abort active session (if any). Persisted `sessionId` is kept for resume. */
  async stop(): Promise<void> {
    await this.#closeSession();
  }

  /** Abort + clear persisted resume id so the next turn starts a fresh thread. */
  async reset(): Promise<void> {
    await this.#closeSession();
    this.#persistedSessionId = "";
    if (this.#store) {
      try {
        await this.#store.resetSession();
      } catch (err) {
        this.#log.warn("session: store reset failed", {
          err: sanitizeError(err),
        });
      }
    }
  }

  /** Daemon-shutdown hook. */
  async close(): Promise<void> {
    await this.#closeSession();
  }

  async #openSession(snapshot: SessionSnapshot): Promise<void> {
    const abort = new AbortController();
    const resumeId = await this.#loadResumeId();
    const extraArgs = effortToExtraArgs(this.#ideId, snapshot.effort);
    this.#log.debug("session: opening", {
      ide: this.#ideId,
      resume: resumeId !== null,
      model: snapshot.model,
    });
    this.#stderrTail = "";
    const session = await this.#ide.openSession!({
      cwd: this.#cwd,
      resumeSessionId: resumeId ?? undefined,
      model: snapshot.model,
      permissionMode: snapshot.permissionMode,
      extraArgs,
      signal: abort.signal,
      onStderr: (chunk) => this.#appendStderr(chunk),
    });
    this.#session = session;
    this.#sessionAbort = abort;
    this.#snapshot = snapshot;
    this.#stoppedByUser = false;
    this.#drainTask = this.#drain(session);
  }

  async #drain(session: RuntimeSession): Promise<void> {
    try {
      for await (const ev of session.events) {
        this.#handleEvent(ev);
      }
    } catch (err) {
      this.#log.warn("session: drain error", { err: sanitizeError(err) });
    } finally {
      const stopped = this.#stoppedByUser;
      this.#stoppedByUser = false;
      if (this.#currentTurn) {
        this.#currentTurn.done.resolve({
          finalText: "",
          isError: true,
          errorDetail: stopped
            ? "stopped by user"
            : "session terminated unexpectedly",
          stopped,
        });
      }
      if (this.#session === session) {
        this.#session = null;
        this.#sessionAbort = null;
        this.#snapshot = null;
      }
    }
    this.#persistIfNeeded(session.sessionId);
  }

  #handleEvent(ev: RuntimeSessionEvent): void {
    const id = this.#session?.sessionId;
    if (id && id !== this.#persistedSessionId) this.#persistIfNeeded(id);
    this.#log.debug("session: event", {
      type: ev.type,
      raw: JSON.stringify(ev.raw).slice(0, 400),
    });
    if (ev.type === "error") {
      // Runtime-level failure (e.g. ai-ide-cli synthetic `send_failed` when
      // the IDE subprocess rejects a send). Without this branch the turn
      // never resolves and the daemon hangs on 🤔 until the user /resets.
      const turn = this.#currentTurn;
      if (!turn) return;
      const raw = ev.raw as Record<string, unknown>;
      const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
      const errText = typeof raw.error === "string" ? raw.error : "";
      const head = subtype && errText
        ? `${subtype}: ${errText}`
        : subtype || errText || "runtime error";
      const tail = this.#stderrTail.trim();
      const detail = tail ? `${head}\nstderr: ${tail}` : head;
      turn.done.resolve({
        finalText: "",
        isError: true,
        errorDetail: detail,
      });
      return;
    }
    if (ev.type === SYNTHETIC_TURN_END) {
      const turn = this.#currentTurn;
      if (!turn) return;
      const raw = ev.raw as Record<string, unknown>;
      const rawResult = typeof raw.result === "string" ? raw.result : "";
      const isError = raw.is_error === true;
      if (isError) {
        const detail = rawResult.length > 0
          ? rawResult
          : typeof raw.subtype === "string"
          ? raw.subtype
          : "(no detail)";
        turn.done.resolve({
          finalText: "",
          isError: true,
          errorDetail: detail,
        });
        return;
      }
      const finalText = rawResult.length > 0
        ? rawResult
        : turn.lastAssistantText;
      turn.done.resolve({ finalText, isError: false });
      return;
    }
    const turn = this.#currentTurn;
    if (!turn) return;
    try {
      for (const part of extractSessionContent(ev)) {
        if (part.kind === "text") {
          if (part.cumulative) turn.lastAssistantText = part.text;
          else turn.lastAssistantText += part.text;
        } else if (part.kind === "final") {
          turn.lastAssistantText = part.text;
        }
        turn.live.appendNormalized(part);
      }
    } catch (err) {
      this.#log.warn("session: appendNormalized failed", {
        err: sanitizeError(err),
      });
    }
  }

  async #closeSession(): Promise<void> {
    if (!this.#session) return;
    const abort = this.#sessionAbort;
    const drain = this.#drainTask;
    const sess = this.#session;
    abort?.abort("closing session");
    try {
      await sess.done;
    } catch {
      // contract: `done` never rejects, but be defensive
    }
    if (drain) await drain.catch(() => {});
    await this.#persistChain.catch(() => {});
    if (this.#session === sess) {
      this.#session = null;
      this.#sessionAbort = null;
      this.#snapshot = null;
      this.#drainTask = null;
    }
  }

  async #loadResumeId(): Promise<string | null> {
    if (this.#persistedSessionId) return this.#persistedSessionId;
    if (!this.#store) return null;
    const id = await this.#store.loadSession();
    this.#persistedSessionId = id ?? "";
    return id;
  }

  /** Append a stderr chunk to the ring buffer; keep only the last 1500 chars
   * so a runaway runtime cannot blow memory while still leaving enough
   * context to diagnose a `send_failed`. */
  #appendStderr(chunk: string): void {
    if (!chunk) return;
    this.#log.debug("session: stderr", { chunk: chunk.slice(0, 400) });
    const combined = this.#stderrTail + chunk;
    const MAX = 1500;
    this.#stderrTail = combined.length > MAX
      ? combined.slice(combined.length - MAX)
      : combined;
  }

  // FR-SESSION-RESUME: persist `RuntimeSession.sessionId` atomically.
  /** Queue a persist write. Returns immediately; `close()` awaits the chain. */
  #persistIfNeeded(sessionId: string): void {
    if (!sessionId || sessionId === this.#persistedSessionId) return;
    this.#persistedSessionId = sessionId;
    if (!this.#store) return;
    const store = this.#store;
    this.#persistChain = this.#persistChain.then(async () => {
      try {
        await store.saveSession(sessionId);
      } catch (err) {
        this.#log.warn("session: persist failed", {
          err: sanitizeError(err),
        });
      }
    });
  }
}

// Claude-specific; other runtimes have no `--effort` flag in ai-ide-cli.
// Duplicate of dispatcher.ts#effortToExtraArgs — kept local so SessionManager
// has no dispatcher coupling.
function effortToExtraArgs(
  ide: SupportedIde,
  effort?: string,
): ExtraArgsMap | undefined {
  if (!effort) return undefined;
  if (ide !== "claude") return undefined;
  return { "--effort": effort };
}
