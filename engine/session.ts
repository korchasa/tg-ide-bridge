/**
 * @module
 * Per-IDE persistent store for daemon state (FR-SESSION-RESUME, FR-SETTINGS).
 * Backs `.tg-ide-bridge/session.json` with a top-level `ides` map keyed by the
 * IDE identifier, each holding its own `session` (resume token) and `settings`
 * sections. Users who swap `FLOWAI_BRIDGE_IDE` mid-project keep separate
 * conversations and tuning per IDE.
 *
 * Migration is automatic on read:
 * - Legacy flat `{token, updatedAt}` — pre-v0.2, single-IDE.
 * - Intermediate `{session, settings}` — v0.1.x, single-IDE.
 * Both formats load into the current store's IDE slot; the next write rewrites
 * the file in the per-IDE shape.
 *
 * All writes are atomic (temp-file + rename) and 0600 on POSIX.
 */

import { dirname, join } from "@std/path";
import type { SupportedIde } from "./config.ts";
import type { StoredSettings } from "./settings.ts";

interface SessionSection {
  token: string;
  updatedAt: string;
}

interface IdeState {
  session?: SessionSection;
  settings?: StoredSettings;
}

interface FileState {
  ides: Partial<Record<SupportedIde, IdeState>>;
}

export interface SessionStoreOptions {
  /** Injectable rename for testing atomic-write failure modes. */
  rename?: (oldPath: string, newPath: string) => Promise<void>;
}

const SESSION_DIR = ".tg-ide-bridge";
const SESSION_FILE = "session.json";

export class SessionStore {
  readonly #filePath: string;
  readonly #ide: SupportedIde;
  readonly #rename: (from: string, to: string) => Promise<void>;

  constructor(
    baseDir: string,
    ide: SupportedIde,
    opts: SessionStoreOptions = {},
  ) {
    this.#filePath = join(baseDir, SESSION_DIR, SESSION_FILE);
    this.#ide = ide;
    this.#rename = opts.rename ?? Deno.rename;
  }

  /** Absolute path to the store file. Exposed for tests. */
  get path(): string {
    return this.#filePath;
  }

  async loadSession(): Promise<string | null> {
    const state = await this.#read();
    const tok = state.ides[this.#ide]?.session?.token;
    return typeof tok === "string" && tok.length > 0 ? tok : null;
  }

  // FR-SESSION-RESUME: atomic write (temp + rename) with 0600 perms.
  async saveSession(token: string): Promise<void> {
    const prev = await this.#read();
    const slot = this.#slot(prev);
    slot.session = { token, updatedAt: new Date().toISOString() };
    await this.#write(prev);
  }

  async resetSession(): Promise<void> {
    const prev = await this.#read();
    const slot = prev.ides[this.#ide];
    if (!slot || slot.session === undefined) return;
    delete slot.session;
    if (slot.settings === undefined) delete prev.ides[this.#ide];
    await this.#writeOrRemove(prev);
  }

  async loadSettings(): Promise<StoredSettings> {
    const state = await this.#read();
    return { ...(state.ides[this.#ide]?.settings ?? {}) };
  }

  // FR-SETTINGS: merge-patch write. `undefined` in patch clears that field.
  async saveSettings(patch: Partial<StoredSettings>): Promise<void> {
    const prev = await this.#read();
    const slot = this.#slot(prev);
    const cur: StoredSettings = { ...(slot.settings ?? {}) };
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
      delete slot.settings;
    } else {
      slot.settings = cur;
    }
    if (slot.session === undefined && slot.settings === undefined) {
      delete prev.ides[this.#ide];
    }
    await this.#writeOrRemove(prev);
  }

  async resetSettings(): Promise<void> {
    const prev = await this.#read();
    const slot = prev.ides[this.#ide];
    if (!slot || slot.settings === undefined) return;
    delete slot.settings;
    if (slot.session === undefined) delete prev.ides[this.#ide];
    await this.#writeOrRemove(prev);
  }

  /** Ensure the current IDE's slot exists and return it. */
  #slot(state: FileState): IdeState {
    let slot = state.ides[this.#ide];
    if (!slot) {
      slot = {};
      state.ides[this.#ide] = slot;
    }
    return slot;
  }

  async #writeOrRemove(state: FileState): Promise<void> {
    if (Object.keys(state.ides).length === 0) {
      await this.#removeFile();
      return;
    }
    await this.#write(state);
  }

  async #read(): Promise<FileState> {
    try {
      const raw = await Deno.readTextFile(this.#filePath);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return normalize(parsed, this.#ide);
    } catch {
      return { ides: {} };
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

function parseSettings(st: Record<string, unknown>): StoredSettings {
  const out: StoredSettings = {};
  if (typeof st.model === "string") out.model = st.model;
  if (typeof st.effort === "string") out.effort = st.effort;
  if (typeof st.permissionMode === "string") {
    out.permissionMode = st.permissionMode;
  }
  if (typeof st.timeoutSeconds === "number") {
    out.timeoutSeconds = st.timeoutSeconds;
  }
  if (typeof st.maxRetries === "number") out.maxRetries = st.maxRetries;
  if (typeof st.retryDelaySeconds === "number") {
    out.retryDelaySeconds = st.retryDelaySeconds;
  }
  return out;
}

function parseSession(s: Record<string, unknown>): SessionSection | undefined {
  if (typeof s.token !== "string" || s.token.length === 0) return undefined;
  return {
    token: s.token,
    updatedAt: typeof s.updatedAt === "string"
      ? s.updatedAt
      : new Date(0).toISOString(),
  };
}

/**
 * Parse/migrate arbitrary JSON into the current `FileState` shape. Legacy
 * single-IDE shapes (`{token,…}` flat or `{session,settings}`) are mapped
 * into the `currentIde` slot.
 */
function normalize(
  raw: Record<string, unknown>,
  currentIde: SupportedIde,
): FileState {
  const out: FileState = { ides: {} };
  // Current shape: { ides: { <ide>: { session?, settings? } } }
  if (raw.ides && typeof raw.ides === "object") {
    for (
      const [id, slotRaw] of Object.entries(
        raw.ides as Record<string, unknown>,
      )
    ) {
      if (!slotRaw || typeof slotRaw !== "object") continue;
      const slot = slotRaw as Record<string, unknown>;
      const ide = id as SupportedIde;
      const parsed: IdeState = {};
      const sess = slot.session as Record<string, unknown> | undefined;
      if (sess) {
        const s = parseSession(sess);
        if (s) parsed.session = s;
      }
      const sets = slot.settings as Record<string, unknown> | undefined;
      if (sets) {
        const s = parseSettings(sets);
        if (Object.keys(s).length > 0) parsed.settings = s;
      }
      if (parsed.session || parsed.settings) out.ides[ide] = parsed;
    }
    return out;
  }
  // Legacy v0.1.x: { session?: {...}, settings?: {...} } — single IDE.
  const slot: IdeState = {};
  const sess = raw.session as Record<string, unknown> | undefined;
  if (sess) {
    const s = parseSession(sess);
    if (s) slot.session = s;
  }
  // Pre-v0.2 flat: { token, updatedAt } — single IDE.
  if (!slot.session && typeof raw.token === "string" && raw.token.length > 0) {
    slot.session = {
      token: raw.token,
      updatedAt: typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : new Date(0).toISOString(),
    };
  }
  const sets = raw.settings as Record<string, unknown> | undefined;
  if (sets) {
    const s = parseSettings(sets);
    if (Object.keys(s).length > 0) slot.settings = s;
  }
  if (slot.session || slot.settings) out.ides[currentIde] = slot;
  return out;
}
