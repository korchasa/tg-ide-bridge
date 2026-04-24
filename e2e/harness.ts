/**
 * @module
 * Real-IDE e2e harness. Wires a real `RuntimeAdapter` from `ai-ide-cli`
 * (spawns the actual IDE binary) through the production `SessionManager`
 * + `Streamer`, with a faked Telegram Bot API. TG stays faked per
 * design decision; the IDE side is the only real component.
 *
 * Skip semantics: `ideSkipReason` probes binary presence first, then a cheap
 * local auth signal (`claude auth status`, `codex login status`,
 * `cursor agent status`, `opencode providers list`). Missing binary/auth or
 * adapter-factory errors become `Deno.test.ignore` with a readable reason.
 *
 * IDE subprocess stderr is captured into an in-memory buffer and only
 * flushed to `console.error` when the test fails, so successful runs
 * stay quiet.
 */

import { SessionManager } from "../engine/ide_session.ts";
import { SessionStore } from "../engine/session.ts";
import { Streamer } from "../engine/tg/streamer.ts";
import { Sender } from "../engine/tg/sender.ts";
import { fakeFetch, type RecordedCall } from "../engine/tg/sender_test_util.ts";
import { createLogger, type Logger } from "../engine/log.ts";
import { SUPPORTED_IDES, type SupportedIde } from "../engine/config.ts";
import {
  DEFAULT_SETTINGS,
  type EffectiveSettings,
} from "../engine/settings.ts";
import {
  getRuntimeAdapter,
  type RuntimeAdapter,
  type RuntimeSession,
  type RuntimeSessionOptions,
} from "@korchasa/ai-ide-cli";

export { SUPPORTED_IDES, type SupportedIde };

export const DEFAULT_E2E_SETTINGS: EffectiveSettings = {
  timeoutSeconds: DEFAULT_SETTINGS.timeoutSeconds,
  maxRetries: DEFAULT_SETTINGS.maxRetries,
  retryDelaySeconds: DEFAULT_SETTINGS.retryDelaySeconds,
};

/** Binary name each IDE adapter spawns. */
const IDE_BINARY: Record<SupportedIde, string> = {
  claude: "claude",
  opencode: "opencode",
  cursor: "cursor",
  codex: "codex",
};

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProbeDeps {
  env?: Record<string, string | undefined>;
  getAdapter?: (ide: SupportedIde) => RuntimeAdapter;
  runCommand?: (cmd: string, args: string[]) => Promise<CommandResult>;
}

async function runCommand(
  cmd: string,
  args: string[],
): Promise<CommandResult> {
  try {
    const child = new Deno.Command(cmd, {
      args,
      env: { ...Deno.env.toObject(), NO_COLOR: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const out = await child.output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (err) {
    return {
      code: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

const ANSI_ESCAPE_RE = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function hasAnyEnv(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function resolveEnv(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return env ?? Deno.env.toObject();
}

async function binaryAvailable(
  bin: string,
  run: (cmd: string, args: string[]) => Promise<CommandResult>,
): Promise<boolean> {
  const out = await run(bin, ["--version"]);
  return out.code === 0;
}

async function hasClaudeAuth(
  env: Record<string, string | undefined>,
  run: (cmd: string, args: string[]) => Promise<CommandResult>,
): Promise<boolean> {
  if (hasAnyEnv(env, ["ANTHROPIC_API_KEY"])) return true;
  const out = await run("claude", ["auth", "status", "--json"]);
  try {
    const parsed = JSON.parse(out.stdout) as { loggedIn?: unknown };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

async function hasCodexAuth(
  env: Record<string, string | undefined>,
  run: (cmd: string, args: string[]) => Promise<CommandResult>,
): Promise<boolean> {
  if (hasAnyEnv(env, ["OPENAI_API_KEY"])) return true;
  const out = await run("codex", ["login", "status"]);
  return out.code === 0 && /logged in/i.test(`${out.stdout}\n${out.stderr}`);
}

async function hasCursorAuth(
  env: Record<string, string | undefined>,
  run: (cmd: string, args: string[]) => Promise<CommandResult>,
): Promise<boolean> {
  if (hasAnyEnv(env, ["CURSOR_API_KEY"])) return true;
  const out = await run("cursor", ["agent", "status"]);
  return out.code === 0;
}

async function hasOpenCodeAuth(
  env: Record<string, string | undefined>,
  run: (cmd: string, args: string[]) => Promise<CommandResult>,
): Promise<boolean> {
  if (
    hasAnyEnv(env, [
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "ZAI_API_KEY",
    ])
  ) {
    return true;
  }
  const out = await run("opencode", ["providers", "list"]);
  if (out.code !== 0) return false;
  const clean = stripAnsi(`${out.stdout}\n${out.stderr}`);
  const match = clean.match(/\b(\d+)\s+credentials\b/i);
  return match !== null && Number(match[1]) > 0;
}

async function hasAuth(
  ide: SupportedIde,
  env: Record<string, string | undefined>,
  run: (cmd: string, args: string[]) => Promise<CommandResult>,
): Promise<boolean> {
  switch (ide) {
    case "claude":
      return await hasClaudeAuth(env, run);
    case "opencode":
      return await hasOpenCodeAuth(env, run);
    case "cursor":
      return await hasCursorAuth(env, run);
    case "codex":
      return await hasCodexAuth(env, run);
  }
}

function authHint(ide: SupportedIde): string {
  switch (ide) {
    case "claude":
      return "missing Claude auth (ANTHROPIC_API_KEY or `claude auth login`)";
    case "opencode":
      return "missing OpenCode provider credentials (`opencode providers login` or provider API key env)";
    case "cursor":
      return "missing Cursor auth (CURSOR_API_KEY or `cursor agent login`)";
    case "codex":
      return "missing Codex auth (OPENAI_API_KEY or `codex login`)";
  }
}

export function stopPromptForIde(ide: SupportedIde): string {
  switch (ide) {
    case "opencode":
      return "Count from 1 to 10000, one number per line, no preamble, and do not stop early.";
    default:
      return "Use the Bash tool to run `sleep 20` and then reply with DONE.";
  }
}

/**
 * Return `null` if the IDE is runnable in the current environment,
 * otherwise a short human-readable reason string (used as skip reason).
 * Missing binary → skip. Adapter factory throws → skip. Missing auth
 * credentials → skip via cheap local status probes (no real model call).
 */
export async function ideSkipReason(
  ide: SupportedIde,
  deps: ProbeDeps = {},
): Promise<string | null> {
  const getAdapter = deps.getAdapter ?? getRuntimeAdapter;
  const run = deps.runCommand ?? runCommand;
  const env = resolveEnv(deps.env);
  let adapter: RuntimeAdapter;
  try {
    adapter = getAdapter(ide);
  } catch (err) {
    return `adapter error: ${(err as Error).message}`;
  }
  if (!adapter.capabilities.session || !adapter.openSession) {
    return "adapter does not advertise session capability";
  }
  const bin = IDE_BINARY[ide];
  if (!(await binaryAvailable(bin, run))) {
    return `binary '${bin}' not found on PATH`;
  }
  if (!(await hasAuth(ide, env, run))) {
    return authHint(ide);
  }
  return null;
}

/** Mutable stderr buffer the harness feeds with IDE subprocess output. */
export interface StderrSink {
  lines: string[];
  flushOnFailure(): void;
}

function makeStderrSink(ide: SupportedIde): StderrSink {
  const lines: string[] = [];
  return {
    lines,
    flushOnFailure(): void {
      if (lines.length === 0) return;
      console.error(`--- [${ide}] captured stderr (${lines.length} lines) ---`);
      for (const l of lines) console.error(l);
      console.error(`--- [${ide}] end stderr ---`);
    },
  };
}

/**
 * Wraps a `RuntimeAdapter` so the harness can observe every `openSession`
 * call — specifically, capture `opts.resumeSessionId` for the resume
 * contract assertion. Production code stays untouched.
 */
export interface AdapterSpy {
  adapter: RuntimeAdapter;
  openCalls: Array<{ resumeSessionId: string | undefined }>;
}

function spyAdapter(inner: RuntimeAdapter): AdapterSpy {
  const openCalls: AdapterSpy["openCalls"] = [];
  const adapter: RuntimeAdapter = {
    id: inner.id,
    capabilities: inner.capabilities,
    invoke: inner.invoke.bind(inner),
    launchInteractive: inner.launchInteractive.bind(inner),
    openSession: inner.openSession
      ? (opts: RuntimeSessionOptions): Promise<RuntimeSession> => {
        openCalls.push({ resumeSessionId: opts.resumeSessionId });
        return inner.openSession!(opts);
      }
      : undefined,
  };
  return { adapter, openCalls };
}

export interface Harness {
  ide: SupportedIde;
  mgr: SessionManager;
  streamer: Streamer;
  store: SessionStore;
  calls: Array<RecordedCall>;
  dir: string;
  stderr: StderrSink;
  openCalls: AdapterSpy["openCalls"];
  cleanup(): Promise<void>;
  /** Pull the last `editMessageText` body text (or "" if none). */
  lastEditBody(): string;
}

function buildHarnessForDir(
  ide: SupportedIde,
  dir: string,
): Harness {
  const { fetchFn, calls } = fakeFetch();
  const sender = new Sender("fake-token", { fetchFn });
  const streamer = new Streamer({ sender });
  const store = new SessionStore(dir, ide);
  const stderr = makeStderrSink(ide);
  const log: Logger = createLogger((line) => stderr.lines.push(line));

  const { adapter, openCalls } = spyAdapter(getRuntimeAdapter(ide));
  // The SessionManager itself wires `onStderr` via its own stderr tail
  // capture; we additionally snoop raw stderr by wrapping `openSession`
  // once more to append into our sink.
  const adapterWithStderr: RuntimeAdapter = {
    ...adapter,
    openSession: adapter.openSession
      ? (opts: RuntimeSessionOptions): Promise<RuntimeSession> => {
        const originalOnStderr = opts.onStderr;
        return adapter.openSession!({
          ...opts,
          onStderr: (chunk: string) => {
            for (const line of chunk.split("\n")) {
              if (line.length > 0) stderr.lines.push(line);
            }
            originalOnStderr?.(chunk);
          },
        });
      }
      : undefined,
  };

  const mgr = new SessionManager({
    ide: adapterWithStderr,
    ideId: ide,
    cwd: dir,
    store,
    log,
  });

  return {
    ide,
    mgr,
    streamer,
    store,
    calls,
    dir,
    stderr,
    openCalls,
    cleanup: async () => {
      try {
        await mgr.close();
      } catch {
        // best-effort
      }
    },
    lastEditBody: () => {
      const edits = calls.filter((c) => c.method === "editMessageText");
      const last = edits.at(-1);
      return last ? String(last.body.text ?? "") : "";
    },
  };
}

export function rebuildHarness(h: Harness): Promise<Harness> {
  return Promise.resolve(buildHarnessForDir(h.ide, h.dir));
}

export async function buildHarness(ide: SupportedIde): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: `tg-ide-bridge-e2e-${ide}-` });
  const h = buildHarnessForDir(ide, dir);
  const cleanup = h.cleanup;
  return {
    ...h,
    cleanup: async () => {
      await cleanup();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

/**
 * Probe every IDE once at module load. Returns a map ide → skip-reason.
 * A `null` reason means "runnable"; a string means "skip with this reason".
 */
export async function probeAllIdes(): Promise<
  Record<SupportedIde, string | null>
> {
  const out = {} as Record<SupportedIde, string | null>;
  for (const ide of SUPPORTED_IDES) {
    out[ide] = await ideSkipReason(ide);
  }
  return out;
}

/**
 * Register a `Deno.test` for each supported IDE. Uses a pre-computed skip map
 * (passed by the caller after a top-level `await probeAllIdes()`) so Deno's
 * runner records the test as ignored (not silently passing) when the IDE is
 * unavailable. Test name: `e2e [<ide>]: <name>`.
 */
export function testPerIde(
  skips: Record<SupportedIde, string | null>,
  name: string,
  run: (h: Harness) => Promise<void>,
): void {
  for (const ide of SUPPORTED_IDES) {
    const reason = skips[ide];
    const testName = reason === null
      ? `e2e [${ide}]: ${name}`
      : `e2e [${ide}]: ${name} (skipped: ${reason})`;
    Deno.test({
      name: testName,
      ignore: reason !== null,
      fn: async () => {
        const h = await buildHarness(ide);
        let failed = false;
        try {
          await run(h);
        } catch (err) {
          failed = true;
          throw err;
        } finally {
          if (failed) h.stderr.flushOnFailure();
          await h.cleanup();
        }
      },
    });
  }
}
