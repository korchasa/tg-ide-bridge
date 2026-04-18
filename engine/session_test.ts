import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { SessionStore } from "./session.ts";

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

Deno.test("SessionStore.loadSession returns null on empty dir", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    assertEquals(await s.loadSession(), null);
  });
});

Deno.test("SessionStore.saveSession then loadSession returns same token", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await s.saveSession("tok-abc");
    assertEquals(await s.loadSession(), "tok-abc");
  });
});

Deno.test("SessionStore.resetSession removes token", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await s.saveSession("tok-1");
    await s.resetSession();
    assertEquals(await s.loadSession(), null);
  });
});

Deno.test("SessionStore.resetSession is no-op when file absent", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await s.resetSession();
    assertEquals(await s.loadSession(), null);
  });
});

Deno.test("SessionStore.loadSession returns null on malformed JSON", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await Deno.mkdir(join(dir, ".tg-ide-bridge"), { recursive: true });
    await Deno.writeTextFile(s.path, "not json {");
    assertEquals(await s.loadSession(), null);
  });
});

Deno.test("SessionStore.saveSession survives rename failure without leaving tmp", async () => {
  await withTempDir(async (dir) => {
    let first = true;
    const s = new SessionStore(dir, {
      rename: async (from, to) => {
        if (first) {
          first = false;
          throw new Error("simulated rename failure");
        }
        await Deno.rename(from, to);
      },
    });
    await assertRejects(() => s.saveSession("tok"));
    const entries: string[] = [];
    for await (const e of Deno.readDir(join(dir, ".tg-ide-bridge"))) {
      entries.push(e.name);
    }
    assertEquals(entries, []);
    await s.saveSession("tok-2");
    assertEquals(await s.loadSession(), "tok-2");
  });
});

Deno.test({
  name: "SessionStore.saveSession writes file with mode 0600 (POSIX)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const s = new SessionStore(dir);
      await s.saveSession("tok");
      const st = await Deno.stat(s.path);
      const mode = (st.mode ?? 0) & 0o777;
      assertEquals(mode, 0o600);
    });
  },
});

Deno.test("SessionStore migrates legacy flat {token, updatedAt} format", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await Deno.mkdir(join(dir, ".tg-ide-bridge"), { recursive: true });
    await Deno.writeTextFile(
      s.path,
      JSON.stringify({
        token: "legacy-tok",
        updatedAt: "2020-01-01T00:00:00Z",
      }),
    );
    assertEquals(await s.loadSession(), "legacy-tok");
    await s.saveSession("new-tok");
    const raw = JSON.parse(await Deno.readTextFile(s.path));
    assertEquals(raw.session.token, "new-tok");
    assertEquals(raw.token, undefined);
  });
});

Deno.test("SessionStore.loadSettings returns empty object when unset", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    assertEquals(await s.loadSettings(), {});
  });
});

Deno.test("SessionStore.saveSettings merges patch into stored settings", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await s.saveSettings({ model: "opus", timeoutSeconds: 42 });
    await s.saveSettings({ effort: "high" });
    assertEquals(await s.loadSettings(), {
      model: "opus",
      timeoutSeconds: 42,
      effort: "high",
    });
  });
});

Deno.test("SessionStore.saveSettings with undefined clears the field", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await s.saveSettings({ model: "opus", effort: "high" });
    await s.saveSettings({ model: undefined });
    assertEquals(await s.loadSettings(), { effort: "high" });
  });
});

Deno.test("SessionStore session and settings coexist in one file", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await s.saveSession("tok");
    await s.saveSettings({ model: "opus" });
    const raw = JSON.parse(await Deno.readTextFile(s.path));
    assertEquals(raw.session.token, "tok");
    assertEquals(raw.settings.model, "opus");
    assertEquals(await s.loadSession(), "tok");
    assertEquals(await s.loadSettings(), { model: "opus" });
  });
});

Deno.test("SessionStore.resetSettings clears settings but keeps session", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await s.saveSession("tok");
    await s.saveSettings({ model: "opus" });
    await s.resetSettings();
    assertEquals(await s.loadSettings(), {});
    assertEquals(await s.loadSession(), "tok");
  });
});

Deno.test("SessionStore removes file when both session and settings are gone", async () => {
  await withTempDir(async (dir) => {
    const s = new SessionStore(dir);
    await s.saveSession("tok");
    await s.saveSettings({ model: "opus" });
    await s.resetSession();
    await s.resetSettings();
    try {
      await Deno.stat(s.path);
      throw new Error("expected file to be removed");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  });
});
