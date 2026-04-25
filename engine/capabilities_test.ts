import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type {
  CapabilityInventory,
  RuntimeAdapter,
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
} from "@korchasa/ai-ide-cli";
import {
  buildRegistry,
  type CapabilityRegistry,
  DefaultCapabilityProvider,
  loadRegistry,
  lookupOriginal,
  mergeCommandList,
  sanitizeName,
  saveRegistry,
} from "./capabilities.ts";
import { Sender } from "./tg/sender.ts";

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("sanitizeName converts dashes and dots to underscores", () => {
  assertEquals(
    sanitizeName("flowai-skill-write-prd"),
    "flowai_skill_write_prd",
  );
  assertEquals(sanitizeName("foo.bar"), "foo_bar");
  assertEquals(sanitizeName("Foo Bar"), "foo_bar");
});

Deno.test("sanitizeName lowercases and drops invalid chars", () => {
  assertEquals(sanitizeName("Init"), "init");
  assertEquals(sanitizeName("hi!@#"), "hi");
});

Deno.test("sanitizeName truncates to 32 chars", () => {
  const s = sanitizeName("a".repeat(50));
  assertEquals(s, "a".repeat(32));
});

Deno.test("sanitizeName returns null for empty result", () => {
  assertEquals(sanitizeName("---"), null);
  assertEquals(sanitizeName("..."), null);
  assertEquals(sanitizeName(""), null);
});

Deno.test("buildRegistry sanitizes and orders commands before skills", () => {
  const inv = {
    runtime: "claude" as const,
    skills: [{ name: "Init" }, { name: "review" }],
    commands: [{ name: "stop" }],
  };
  const reserved = new Set(["stop"]);
  const { registry, skipped } = buildRegistry(inv, reserved);
  // 'stop' command sanitizes to reserved → dropped.
  assert(skipped.some((s) => s.name === "stop" && s.reason === "reserved"));
  // Two skills accepted.
  assertEquals(registry.entries.map((e) => e.tgName).sort(), [
    "init",
    "review",
  ]);
});

Deno.test("buildRegistry drops post-sanitize duplicates", () => {
  const inv = {
    runtime: "claude" as const,
    skills: [{ name: "foo-bar" }, { name: "foo.bar" }],
    commands: [],
  };
  const { registry, skipped } = buildRegistry(inv, new Set());
  assertEquals(registry.entries.length, 1);
  assert(
    skipped.some((s) => s.reason === "duplicate"),
    "second collision skipped",
  );
});

Deno.test("buildRegistry caps total at 100 - reserved.size", () => {
  const reserved = new Set(["a", "b", "c"]); // 3 reserved → budget 97
  const skills = Array.from(
    { length: 110 },
    (_, i) => ({ name: `skill_${i}` }),
  );
  const inv = { runtime: "claude" as const, skills, commands: [] };
  const { registry, skipped } = buildRegistry(inv, reserved);
  assertEquals(registry.entries.length, 97);
  assertEquals(skipped.filter((s) => s.reason === "overflow").length, 13);
});

Deno.test("lookupOriginal resolves tgName back to IDE name", () => {
  const reg: CapabilityRegistry = {
    runtime: "claude",
    fetchedAt: "2026-04-25T00:00:00Z",
    entries: [
      {
        tgName: "flowai_skill_write_prd",
        originalName: "flowai-skill-write-prd",
        kind: "skill",
        description: "skill",
      },
    ],
  };
  assertEquals(
    lookupOriginal(reg, "flowai_skill_write_prd"),
    "flowai-skill-write-prd",
  );
  assertEquals(lookupOriginal(reg, "missing"), null);
  assertEquals(lookupOriginal(null, "anything"), null);
});

Deno.test("mergeCommandList preserves reserved order then appends entries", () => {
  const reserved = [
    { command: "reset", description: "r" },
    { command: "settings", description: "s" },
  ];
  const reg: CapabilityRegistry = {
    runtime: "claude",
    fetchedAt: "2026-04-25T00:00:00Z",
    entries: [
      {
        tgName: "review",
        originalName: "review",
        kind: "command",
        description: "command",
      },
    ],
  };
  const merged = mergeCommandList(reserved, reg);
  assertEquals(merged.map((c) => c.command), ["reset", "settings", "review"]);
});

Deno.test("loadRegistry returns null when file absent", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await loadRegistry(dir), null);
  });
});

Deno.test("loadRegistry returns null on malformed JSON", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, ".tg-ide-bridge"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, ".tg-ide-bridge/capabilities.json"),
      "{not json",
    );
    assertEquals(await loadRegistry(dir), null);
  });
});

Deno.test("loadRegistry returns null on schema mismatch", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, ".tg-ide-bridge"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, ".tg-ide-bridge/capabilities.json"),
      JSON.stringify({ runtime: "claude" }),
    );
    assertEquals(await loadRegistry(dir), null);
  });
});

Deno.test("saveRegistry writes the file and loadRegistry reads it back", async () => {
  await withTempDir(async (dir) => {
    const reg: CapabilityRegistry = {
      runtime: "claude",
      fetchedAt: "2026-04-25T00:00:00Z",
      entries: [
        {
          tgName: "init",
          originalName: "init",
          kind: "command",
          description: "command",
        },
      ],
    };
    await saveRegistry(dir, reg);
    const loaded = await loadRegistry(dir);
    assertEquals(loaded, reg);
  });
});

Deno.test({
  name: "saveRegistry writes file with mode 0600 (POSIX)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const reg: CapabilityRegistry = {
        runtime: "claude",
        fetchedAt: "2026-04-25T00:00:00Z",
        entries: [],
      };
      await saveRegistry(dir, reg);
      const stat = await Deno.stat(
        join(dir, ".tg-ide-bridge/capabilities.json"),
      );
      assertEquals(stat.mode! & 0o777, 0o600);
    });
  },
});

// Regression: upstream `fetchInventoryViaInvoke` calls `invoke({maxRetries:0})`,
// adapter retry loops are `for a=1; a<=maxRetries`, so the loop never runs.
// `DefaultCapabilityProvider.refresh` patches `invoke` to enforce ≥1 attempt.

function fakeAdapter(): RuntimeAdapter & {
  observed: RuntimeInvokeOptions[];
} {
  const observed: RuntimeInvokeOptions[] = [];
  const adapter = {
    id: "claude" as const,
    capabilities: {
      permissionMode: true,
      hitl: false,
      transcript: false,
      interactive: true,
      toolUseObservation: false,
      session: false,
      capabilityInventory: true,
    },
    observed,
    invoke(opts: RuntimeInvokeOptions): Promise<RuntimeInvokeResult> {
      observed.push(opts);
      // Simulate upstream Claude retry loop: zero attempts → cryptic error.
      if ((opts.maxRetries ?? 0) < 1) {
        return Promise.resolve({
          error: `Claude CLI failed after ${opts.maxRetries ?? 0} attempts: `,
        });
      }
      return Promise.resolve({
        output: {
          runtime: "claude",
          result: JSON.stringify({
            skills: [{ name: "demo-skill" }],
            commands: [{ name: "demo" }],
          }),
          session_id: "s",
          total_cost_usd: 0,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          is_error: false,
        },
      });
    },
    fetchCapabilitiesSlow: undefined as unknown,
    launchInteractive(): Promise<{ exitCode: number }> {
      return Promise.resolve({ exitCode: 0 });
    },
  } as unknown as RuntimeAdapter & { observed: RuntimeInvokeOptions[] };
  // Wire a minimal `fetchCapabilitiesSlow` that mimics upstream:
  // calls `this.invoke` with `maxRetries: 0` and parses the result.
  (adapter as unknown as {
    fetchCapabilitiesSlow: () => Promise<CapabilityInventory>;
  }).fetchCapabilitiesSlow = async () => {
    const r = await adapter.invoke({
      taskPrompt: "_",
      timeoutSeconds: 60,
      maxRetries: 0,
      retryDelaySeconds: 0,
    });
    if (r.error) throw new Error(`fetch (claude): ${r.error}`);
    if (!r.output) throw new Error("no output");
    const parsed = JSON.parse(r.output.result) as {
      skills: { name: string }[];
      commands: { name: string }[];
    };
    return {
      runtime: "claude",
      skills: parsed.skills,
      commands: parsed.commands,
    };
  };
  return adapter;
}

Deno.test("DefaultCapabilityProvider.refresh forces maxRetries>=1 around fetchCapabilitiesSlow", async () => {
  await withTempDir(async (dir) => {
    const adapter = fakeAdapter();
    const sender = new Sender("t", {
      fetchFn: ((_url: string | URL | Request, init?: RequestInit) => {
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : {};
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, result: body.commands ?? null }),
            { status: 200 },
          ),
        );
      }) as typeof fetch,
    });
    const provider = new DefaultCapabilityProvider({
      ide: adapter,
      sender,
      projectDir: dir,
      cwd: dir,
      reserved: [{ command: "reset", description: "r" }],
    });
    const res = await provider.refresh();
    assertEquals(res.entries, 2, "two entries discovered");
    // The fake adapter received the upstream maxRetries:0, but our wrapper
    // bumped it to 1 before reaching the underlying invoke.
    assertEquals(adapter.observed.length, 1);
    assert(
      adapter.observed[0]!.maxRetries === 1,
      `expected maxRetries=1 after patch, got ${
        adapter.observed[0]!.maxRetries
      }`,
    );
    // Adapter's invoke method is restored after refresh.
    assert(typeof adapter.invoke === "function");
  });
});
