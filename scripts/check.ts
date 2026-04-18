#!/usr/bin/env -S deno run -A
// Comprehensive project verification: fmt, lint, comment-scan, tests.
// Runs independent checks in parallel with buffered output; prints passed
// checks first, failed checks last; exits non-zero on any failure.

type CheckResult = {
  name: string;
  ok: boolean;
  output: string;
  durationMs: number;
};

type Check = {
  name: string;
  run: () => Promise<CheckResult>;
};

const NO_COLOR = Deno.env.get("NO_COLOR") !== undefined;
const color = (
  code: string,
  s: string,
) => (NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
const green = (s: string) => color("32", s);
const red = (s: string) => color("31", s);
const dim = (s: string) => color("2", s);

async function runCmd(name: string, cmd: string[]): Promise<CheckResult> {
  const start = performance.now();
  console.log(dim(`▶ ${name} …`));
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  });
  const { code, stdout, stderr } = await p.output();
  const dec = new TextDecoder();
  const out = dec.decode(stdout) + dec.decode(stderr);
  const durationMs = Math.round(performance.now() - start);
  const ok = code === 0;
  console.log(
    `${ok ? green("✓") : red("✗")} ${name} ${dim(`(${durationMs}ms)`)}`,
  );
  return { name, ok, output: out, durationMs };
}

async function commentScan(): Promise<CheckResult> {
  const start = performance.now();
  console.log(dim("▶ comment-scan …"));
  const patterns = [
    /\bTODO\b/,
    /\bFIXME\b/,
    /\bHACK\b/,
    /\bXXX\b/,
    /\bdebugger\b/,
    /\/\/\s*deno-lint-ignore/,
    /\/\/\s*deno-fmt-ignore/,
    /\/\/\s*eslint-disable/,
    /\/\/\s*@ts-ignore/,
    /\/\/\s*@ts-nocheck/,
  ];
  const exts = new Set([".ts", ".tsx", ".js", ".mjs"]);
  const excludeDirs = new Set([
    ".git",
    "node_modules",
    ".claude",
    "dist",
    "build",
  ]);
  const hits: string[] = [];
  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (excludeDirs.has(entry.name)) continue;
        await walk(path);
        continue;
      }
      if (!entry.isFile) continue;
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot);
      if (!exts.has(ext)) continue;
      // Skip self to avoid matching our own pattern literals.
      if (path.endsWith("scripts/check.ts")) continue;
      const text = await Deno.readTextFile(path);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const p of patterns) {
          if (p.test(lines[i])) {
            hits.push(`${path}:${i + 1}: ${lines[i].trim()}`);
            break;
          }
        }
      }
    }
  }
  await walk(".");
  const durationMs = Math.round(performance.now() - start);
  const ok = hits.length === 0;
  const output = ok ? "no forbidden markers found" : hits.join("\n");
  console.log(
    `${ok ? green("✓") : red("✗")} comment-scan ${dim(`(${durationMs}ms)`)}`,
  );
  return { name: "comment-scan", ok, output, durationMs };
}

const checks: Check[] = [
  { name: "fmt", run: () => runCmd("fmt", ["deno", "fmt", "--check"]) },
  { name: "lint", run: () => runCmd("lint", ["deno", "lint"]) },
  { name: "comment-scan", run: commentScan },
  {
    name: "test",
    run: () =>
      runCmd("test", ["deno", "test", "-A", "--no-check", "--permit-no-files"]),
  },
];

const results = await Promise.all(checks.map((c) => c.run()));

console.log("");
console.log(dim("─── passed ───"));
for (const r of results.filter((r) => r.ok)) {
  console.log(green(`✓ ${r.name}`));
  if (r.output.trim()) console.log(dim(r.output));
}
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log("");
  console.log(red("─── failed ───"));
  for (const r of failed) {
    console.log(red(`✗ ${r.name}`));
    console.log(r.output);
  }
}

const total = results.length;
const passedCount = results.length - failed.length;
console.log("");
console.log(
  failed.length === 0
    ? green(`all checks passed (${passedCount}/${total})`)
    : red(`${failed.length} check(s) failed (${passedCount}/${total} passed)`),
);

Deno.exit(failed.length === 0 ? 0 : 1);
