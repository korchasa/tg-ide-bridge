/**
 * @module
 * Capability inventory: discover IDE skills/slash-commands and expose them
 * as Telegram bot commands (FR-CAPABILITY-INVENTORY). Pure CRUD over a JSON
 * cache + sanitization to TG's bot-command regex.
 */

import { dirname, join } from "@std/path";
import type {
  CapabilityInventory,
  CapabilityRef,
  RuntimeAdapter,
} from "@korchasa/ai-ide-cli";
import type { Sender } from "./tg/sender.ts";

const CACHE_FILE = ".tg-ide-bridge/capabilities.json";
const TG_NAME_MAX = 32;
const TG_TOTAL_MAX = 100;
const TG_NAME_RE = /^[a-z0-9_]{1,32}$/;

export interface CapabilityEntry {
  /** Sanitized name registered with Telegram (`^[a-z0-9_]{1,32}$`). */
  tgName: string;
  /** Original IDE name as the agent reports it (preserves dashes etc.). */
  originalName: string;
  kind: "skill" | "command";
  description: string;
}

export interface CapabilityRegistry {
  runtime: string;
  fetchedAt: string; // ISO 8601
  entries: CapabilityEntry[];
}

export interface SkippedEntry {
  name: string;
  reason: "invalid" | "reserved" | "duplicate" | "overflow";
}

export interface BuildResult {
  registry: CapabilityRegistry;
  skipped: SkippedEntry[];
}

// FR-CAPABILITY-INVENTORY
export function sanitizeName(raw: string): string | null {
  const lowered = raw.toLowerCase();
  const replaced = lowered.replace(/[-.\s]+/g, "_");
  const filtered = replaced.replace(/[^a-z0-9_]/g, "");
  const trimmed = filtered.replace(/^_+|_+$/g, "");
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, TG_NAME_MAX);
}

interface NormalizedEntry {
  ref: CapabilityRef;
  kind: "skill" | "command";
}

// FR-CAPABILITY-INVENTORY
export function buildRegistry(
  inv: CapabilityInventory,
  reserved: ReadonlySet<string>,
  now: () => Date = () => new Date(),
): BuildResult {
  const skipped: SkippedEntry[] = [];
  const seen = new Set<string>();
  const accepted: CapabilityEntry[] = [];
  const budget = Math.max(0, TG_TOTAL_MAX - reserved.size);

  // Commands first, then skills — gives slash commands priority on overflow.
  const ordered: NormalizedEntry[] = [
    ...inv.commands.map((ref) => ({ ref, kind: "command" as const })),
    ...inv.skills.map((ref) => ({ ref, kind: "skill" as const })),
  ];

  for (const { ref, kind } of ordered) {
    const tgName = sanitizeName(ref.name);
    if (tgName === null) {
      skipped.push({ name: ref.name, reason: "invalid" });
      continue;
    }
    if (reserved.has(tgName)) {
      skipped.push({ name: ref.name, reason: "reserved" });
      continue;
    }
    if (seen.has(tgName)) {
      skipped.push({ name: ref.name, reason: "duplicate" });
      continue;
    }
    if (accepted.length >= budget) {
      skipped.push({ name: ref.name, reason: "overflow" });
      continue;
    }
    seen.add(tgName);
    accepted.push({
      tgName,
      originalName: ref.name,
      kind,
      description: describe(ref, kind),
    });
  }

  // Stable ordering for setMyCommands rendering: commands then skills,
  // alphabetical by tgName within each group.
  accepted.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "command" ? -1 : 1;
    return a.tgName.localeCompare(b.tgName);
  });

  return {
    registry: {
      runtime: inv.runtime,
      fetchedAt: now().toISOString(),
      entries: accepted,
    },
    skipped,
  };
}

function describe(ref: CapabilityRef, kind: "skill" | "command"): string {
  const src = ref.plugin ? ` (${ref.plugin})` : "";
  return `${kind}${src}`;
}

export function lookupOriginal(
  registry: CapabilityRegistry | null,
  tgName: string,
): string | null {
  if (!registry) return null;
  for (const e of registry.entries) {
    if (e.tgName === tgName) return e.originalName;
  }
  return null;
}

export interface BotCommand {
  command: string;
  description: string;
}

export function mergeCommandList(
  reserved: ReadonlyArray<BotCommand>,
  registry: CapabilityRegistry | null,
): BotCommand[] {
  const out: BotCommand[] = [...reserved];
  if (registry) {
    for (const e of registry.entries) {
      out.push({ command: e.tgName, description: e.description });
    }
  }
  return out;
}

// FR-CAPABILITY-INVENTORY
export async function loadRegistry(
  projectDir: string,
): Promise<CapabilityRegistry | null> {
  const path = join(projectDir, CACHE_FILE);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRegistry(parsed)) return null;
  return parsed;
}

function isRegistry(v: unknown): v is CapabilityRegistry {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.runtime !== "string") return false;
  if (typeof r.fetchedAt !== "string") return false;
  if (!Array.isArray(r.entries)) return false;
  for (const e of r.entries) {
    if (typeof e !== "object" || e === null) return false;
    const x = e as Record<string, unknown>;
    if (typeof x.tgName !== "string" || !TG_NAME_RE.test(x.tgName)) {
      return false;
    }
    if (typeof x.originalName !== "string" || x.originalName.length === 0) {
      return false;
    }
    if (x.kind !== "skill" && x.kind !== "command") return false;
    if (typeof x.description !== "string") return false;
  }
  return true;
}

// FR-CAPABILITY-INVENTORY
export async function saveRegistry(
  projectDir: string,
  reg: CapabilityRegistry,
): Promise<void> {
  const path = join(projectDir, CACHE_FILE);
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${crypto.randomUUID()}`;
  const body = JSON.stringify(reg, null, 2);
  await Deno.writeTextFile(tmp, body);
  try {
    if (Deno.build.os !== "windows") {
      await Deno.chmod(tmp, 0o600);
    }
    await Deno.rename(tmp, path);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

export interface RefreshResult {
  entries: number;
  skipped: SkippedEntry[];
}

/** Read-only access plus refresh trigger; consumed by `Dispatcher`. */
export interface CapabilityProvider {
  current(): CapabilityRegistry | null;
  refresh(): Promise<RefreshResult>;
}

export interface ProviderOpts {
  ide: RuntimeAdapter;
  sender: Sender;
  projectDir: string;
  cwd: string;
  reserved: ReadonlyArray<BotCommand>;
  initial?: CapabilityRegistry | null;
  fetchTimeoutSeconds?: number;
}

// FR-CAPABILITY-INVENTORY
export class DefaultCapabilityProvider implements CapabilityProvider {
  readonly #ide: RuntimeAdapter;
  readonly #sender: Sender;
  readonly #projectDir: string;
  readonly #cwd: string;
  readonly #reserved: ReadonlyArray<BotCommand>;
  readonly #fetchTimeoutSeconds: number;
  #registry: CapabilityRegistry | null;

  constructor(opts: ProviderOpts) {
    this.#ide = opts.ide;
    this.#sender = opts.sender;
    this.#projectDir = opts.projectDir;
    this.#cwd = opts.cwd;
    this.#reserved = opts.reserved;
    this.#fetchTimeoutSeconds = opts.fetchTimeoutSeconds ?? 120;
    this.#registry = opts.initial ?? null;
  }

  current(): CapabilityRegistry | null {
    return this.#registry;
  }

  async refresh(): Promise<RefreshResult> {
    if (!this.#ide.fetchCapabilitiesSlow) {
      throw new Error(
        `runtime '${this.#ide.id}' does not implement fetchCapabilitiesSlow`,
      );
    }
    const inv = await this.#ide.fetchCapabilitiesSlow({
      cwd: this.#cwd,
      timeoutSeconds: this.#fetchTimeoutSeconds,
    });
    const reservedSet = new Set(this.#reserved.map((c) => c.command));
    const { registry, skipped } = buildRegistry(inv, reservedSet);
    await saveRegistry(this.#projectDir, registry);
    await this.#sender.setMyCommands(
      mergeCommandList(this.#reserved, registry),
    );
    this.#registry = registry;
    return { entries: registry.entries.length, skipped };
  }
}
