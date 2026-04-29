import { assertEquals } from "@std/assert";
import {
  ideSkipReason,
  type ProbeDeps,
  stopPromptForIde,
  type SupportedIde,
} from "./harness.ts";
import type { RuntimeAdapter } from "@korchasa/ai-ide-cli";

function sessionCapableAdapter(): RuntimeAdapter {
  return {
    id: "claude",
    capabilities: {
      permissionMode: false,
      hitl: false,
      transcript: false,
      interactive: false,
      toolUseObservation: false,
      session: true,
      capabilityInventory: false,
      toolFilter: false,
      reasoningEffort: false,
    },
    invoke: () => Promise.resolve({ error: "unused" }),
    launchInteractive: () => Promise.resolve({ exitCode: 0 }),
    openSession: () => Promise.reject(new Error("unused")),
  };
}

function probeDeps(
  ide: SupportedIde,
  run: NonNullable<ProbeDeps["runCommand"]>,
  env: ProbeDeps["env"] = {},
): ProbeDeps {
  return {
    env,
    getAdapter: (actualIde: SupportedIde) => {
      assertEquals(actualIde, ide);
      return sessionCapableAdapter();
    },
    runCommand: run,
  };
}

Deno.test("ideSkipReason skips Claude when auth status reports logged out", async () => {
  const reason = await ideSkipReason(
    "claude",
    probeDeps("claude", (cmd, args) => {
      if (cmd === "claude" && args[0] === "--version") {
        return Promise.resolve({ code: 0, stdout: "1.0.0\n", stderr: "" });
      }
      assertEquals(cmd, "claude");
      assertEquals(args, ["auth", "status", "--json"]);
      return Promise.resolve({
        code: 1,
        stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }),
        stderr: "",
      });
    }),
  );
  assertEquals(
    reason,
    "missing Claude auth (ANTHROPIC_API_KEY or `claude auth login`)",
  );
});

Deno.test("ideSkipReason accepts Claude when ANTHROPIC_API_KEY is set", async () => {
  const reason = await ideSkipReason(
    "claude",
    probeDeps(
      "claude",
      (cmd, args) => {
        assertEquals(cmd, "claude");
        assertEquals(args, ["--version"]);
        return Promise.resolve({ code: 0, stdout: "1.0.0\n", stderr: "" });
      },
      { ANTHROPIC_API_KEY: "test-key" },
    ),
  );
  assertEquals(reason, null);
});

Deno.test("ideSkipReason skips OpenCode when providers list has zero credentials", async () => {
  const reason = await ideSkipReason(
    "opencode",
    probeDeps("opencode", (cmd, args) => {
      if (cmd === "opencode" && args[0] === "--version") {
        return Promise.resolve({ code: 0, stdout: "1.0.0\n", stderr: "" });
      }
      assertEquals(cmd, "opencode");
      assertEquals(args, ["providers", "list"]);
      return Promise.resolve({
        code: 0,
        stdout: "\u001b[0m\n└  0 credentials\n",
        stderr: "",
      });
    }),
  );
  assertEquals(
    reason,
    "missing OpenCode provider credentials (`opencode providers login` or provider API key env)",
  );
});

Deno.test("stopPromptForIde avoids Bash-specific prompt for OpenCode", () => {
  assertEquals(
    stopPromptForIde("opencode"),
    "Count from 1 to 10000, one number per line, no preamble, and do not stop early.",
  );
  assertEquals(
    stopPromptForIde("codex"),
    "Use the Bash tool to run `sleep 20` and then reply with DONE.",
  );
});
