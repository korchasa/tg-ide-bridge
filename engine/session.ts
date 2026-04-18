/**
 * @module
 * Single persistent store for per-project daemon state (FR-SESSION-RESUME,
 * FR-SETTINGS). Backs `.tg-ide-bridge/session.json` with two sections:
 * `session` (IDE `--resume` token) and `settings` (user-tunable IDE params).
 *
 * All writes are atomic (temp-file + rename) and readable-by-owner-only on
 * POSIX. Reads auto-migrate the legacy flat `{token, updatedAt}` shape: the
 * old token is returned by `loadSession()`; the next save rewrites the file
 * in the new shape.
 */

import { dirname, join } from "@std/path";
import type { StoredSettings } from "./settings.ts";

interface SessionSection {
  token: string;
  updatedAt: string;
}

interface FileState {
  session?: SessionSection;
  settings?: StoredSettings;
}

export interface SessionStoreOptions {
  /** Injectable rename for testing atomic-write failure modes. */
  rename?: (oldPath: string, newPath: string) => Promise<void>;
}

const SESSION_DIR = ".tg-ide-bridge";
const SESSION_FILE = "session.json";

export class SessionStore {
  readonly #filePath: string;
  readonly #rename: (from: string, to: string) => Promise<void>;

  constructor(baseDir: string, opts: SessionStoreOptions = {}) {
    this.#filePath = join(baseDir, SESSION_DIR, SESSION_FILE);
    this.#rename = opts.rename ?? Deno.rename;
  }

  /** Absolute path to the store file. Exposed for tests. */
  get path(): string {
    return this.#filePath;
  }

  async loadSession(): Promise<string | null> {
    const state = await this.#read();
    const tok = state.session?.token;
    return typeof tok === "string" && tok.length > 0 ? tok : null;
  }

  // FR-SESSION-RESUME: atomic write (temp + rename) with 0600 perms.
  async saveSession(token: string): Promise<void> {
    const prev = await this.#read();
    prev.session = { token, updatedAt: new Date().toISOString() };
    await this.#write(prev);
  }

  async resetSession(): Promise<void> {
    const prev = await this.#read();
    if (prev.session === undefined) return;
    delete prev.session;
    if (prev.settings === undefined) {
      await this.#removeFile();
      return;
    }
    await this.#write(prev);
  }

  async loadSettings(): Promise<StoredSettings> {
    const state = await this.#read();
    return { ...(state.settings ?? {}) };
  }

  // FR-SETTINGS: merge-patch write. `undefined` in patch clears that field.
  async saveSettings(patch: Partial<StoredSettings>): Promise<void> {
    const prev = await this.#read();
    const cur: StoredSettings = { ...(prev.settings ?? {}) };
    for (
      const [k, v] of Object.entries(patch) as [
        keyof StoredSettings,
        StoredSettings[keyof StoredSettings],
      ][]
    ) {
      if (v === undefined) {
        delete cur[k];
      } else {
        (cur as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(cur).length === 0) {
      delete prev.settings;
    } else {
      prev.settings = cur;
    }
    if (prev.session === undefined && prev.settings === undefined) {
      await this.#removeFile();
      return;
    }
    await this.#write(prev);
  }

  async resetSettings(): Promise<void> {
    const prev = await this.#read();
    if (prev.settings === undefined) return;
    delete prev.settings;
    if (prev.session === undefined) {
      await this.#removeFile();
      return;
    }
    await this.#write(prev);
  }

  async #read(): Promise<FileState> {
    try {
      const raw = await Deno.readTextFile(this.#filePath);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return normalize(parsed);
    } catch {
      return {};
    }
  }

  async #write(state: FileState): Promise<void> {
    await Deno.mkdir(dirname(this.#filePath), { recursive: true });
    const tmp = `${this.#filePath}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(state));
    if (Deno.build.os !== "windows") {
      await Deno.chmod(tmp, 0o600);
    }
    try {
      await this.#rename(tmp, this.#filePath);
    } catch (err) {
      await Deno.remove(tmp).catch(() => {});
      throw err;
    }
  }

  async #removeFile(): Promise<void> {
    try {
      await Deno.remove(this.#filePath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
}

/** Parse/migrate arbitrary JSON into the current `FileState` shape. */
function normalize(raw: Record<string, unknown>): FileState {
  const out: FileState = {};
  // Legacy flat shape: {token, updatedAt}
  if (typeof raw.token === "string" && raw.token.length > 0) {
    out.session = {
      token: raw.token,
      updatedAt: typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : new Date(0).toISOString(),
    };
  }
  const s = raw.session as Record<string, unknown> | undefined;
  if (s && typeof s.token === "string" && s.token.length > 0) {
    out.session = {
      token: s.token,
      updatedAt: typeof s.updatedAt === "string"
        ? s.updatedAt
        : new Date(0).toISOString(),
    };
  }
  const st = raw.settings as Record<string, unknown> | undefined;
  if (st && typeof st === "object") {
    const settings: StoredSettings = {};
    if (typeof st.model === "string") settings.model = st.model;
    if (typeof st.effort === "string") settings.effort = st.effort;
    if (typeof st.permissionMode === "string") {
      settings.permissionMode = st.permissionMode;
    }
    if (typeof st.timeoutSeconds === "number") {
      settings.timeoutSeconds = st.timeoutSeconds;
    }
    if (typeof st.maxRetries === "number") {
      settings.maxRetries = st.maxRetries;
    }
    if (typeof st.retryDelaySeconds === "number") {
      settings.retryDelaySeconds = st.retryDelaySeconds;
    }
    if (Object.keys(settings).length > 0) out.settings = settings;
  }
  return out;
}
