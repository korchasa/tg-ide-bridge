# Core Project Rules
- Follow your assigned role strictly — it defines scope and boundaries for your actions.
- After finishing a session, review all project documents(readme.md, requirements.md, design.md, etc) to ensure they reflect the current state. Stale docs mislead future sessions.
- Verify every change by running appropriate tests or scripts — never assume correctness without evidence.
- Keep the project in a clean state: no errors, warnings, or issues in formatter and linter output. A broken baseline blocks all future work.
- Follow the TDD flow described below. Skipping it leads to untested code and regressions.
- Write all documentation in English, compressed style. Brevity preserves context window.
- If you see contradictions in the request or context, raise them explicitly, ask clarifying questions, and stop. Do not guess which interpretation is correct.
- Code should follow "fail fast, fail clearly" — surface errors immediately with clear messages rather than silently propagating bad state. Unless the user requests otherwise.
- When editing CI/CD pipelines, always validate locally first — broken CI is visible to the whole team and slow to debug remotely.
- Provide evidence for your claims — link to code, docs, or tool output. Unsupported assertions erode trust.
- Use standard tools (jq, yq, jc) to process and manage structured output — they are portable and well-understood.
- Do not add fallbacks, default behaviors, or error recovery silently — if the user didn't ask for it, it's an assumption. If you believe a fallback is genuinely needed, ask the user first.
- Do not use tables in chat output — use two-level lists instead. Tables render poorly in terminal and are harder to scan.

---
## Project-Specific Rules
- **Strict TypeScript**: `strict: true`, no `any`, explicit return types on all exported functions.
- **TDD first**: write failing test → minimal implementation → refactor → run full `check`.
- **Conventional Commits**: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`; imperative mood.
- **Small PRs**: one purpose per PR; keep diff reviewable in <10 min.
- **Secrets never in repo or chat**: Telegram bot tokens, API keys → env vars only. Never echo secrets to TG chat.
- **Daemon is per-project**: one daemon process is bound to one project folder and one TG chat/topic. No cross-project routing in v1.
- **`--resume` is critical state**: treat IDE session IDs as durable state; persist to disk; never silently drop context.

## Project Information
- Project Name: tg-ide-bridge

## Project Vision
A daemon that bridges a Telegram chat to an AI IDE (Claude Code, Cursor, OpenCode, Gemini, etc.) scoped to a single project folder. Users send commands from Telegram; the daemon executes them in the project's context through the AI IDE and streams responses back. Context is preserved across messages via the IDE's `--resume` mechanism, so conversations feel continuous.

Value for power users of AI IDEs: remote control of their coding assistant from phone or any device with Telegram, without exposing a public endpoint or leaving the laptop open.

## Project tooling Stack
- **Runtime**: Deno (TypeScript, native).
- **Workspace**: single member `engine/` (daemon).
- **Std libs**: `@std/assert`, `@std/path`, `@std/yaml`, `@std/semver`, `@std/cli`, `@std/fs` (all from JSR).
- **AI IDE control**: `jsr:@korchasa/ai-ide-cli` — uniform typed `RuntimeAdapter` over multiple AI IDEs; consumed directly by `engine/`, no local wrapper.
- **Telegram**: Bot API via long polling (no public HTTPS required).
- **Testing**: `deno test` (native, no extra framework).
- **Formatting/lint**: `deno fmt`, `deno lint`.

## Architecture
**Pattern**: Single daemon per project folder.

- One long-running Deno process per project directory.
- Daemon holds: Telegram Bot API connection (long-polling), project working directory, AI IDE session handle (`--resume` id).
- Each Telegram message → one AI IDE invocation in the project's cwd → response streamed back to the same chat.
- Session continuity: daemon persists `--resume` token to disk so restarts do not lose conversation context.
- Workspace layout:
  - `engine/` — daemon entrypoint, TG polling loop, command dispatcher, session manager; imports `RuntimeAdapter` from `@korchasa/ai-ide-cli` directly.

## Key Decisions
- **Deno over Node**: zero build step, native TS, built-in test/fmt/lint, single binary via `deno compile`.
- **Long polling over webhooks**: works behind NAT, no public HTTPS, trivial to run locally.
- **Per-project daemon**: simpler isolation, no cross-project auth/routing logic in v1. Multi-project support deferred.
- **`@korchasa/ai-ide-cli` as abstraction layer**: decouples daemon from specific IDE (Claude/Cursor/etc.).
- **TDD + strict TS**: non-negotiable quality floor.

## Documentation Hierarchy
1. **`AGENTS.md`**: Project vision, constraints, mandatory rules. READ-ONLY reference.
2. **SRS** (`documents/requirements.md`): "What" & "Why". Source of truth for requirements.
3. **SDS** (`documents/design.md`): "How". Architecture and implementation. Depends on SRS.
4. **Tasks** (`documents/tasks/<YYYY-MM-DD>-<slug>.md`): Temporary plans/notes per task.
5. **`README.md`**: Public-facing overview. Installation, usage, quick start. Derived from AGENTS.md + SRS + SDS.

## Documentation Map

Maps source code paths to documentation sections that describe them. Used by commit workflows to determine which doc sections need updating when files change.

- `engine/cli.ts` → SDS §3.1; README (install/run).
- `engine/config.ts` → SDS §3.2; SRS FR-CONFIG.
- `engine/auth.ts` → SDS §3.5; SRS FR-AUTH.
- `engine/tg/poller.ts` → SDS §3.3; SRS FR-TG-POLL.
- `engine/tg/sender.ts` → SDS §3.4; SRS FR-RESPONSE-STREAM.
- `engine/tg/streamer.ts` → SDS §3.8; SRS FR-EVENT-STREAM.
- `engine/tg/format.ts` → SDS §3.10; SRS FR-EVENT-STREAM.
- `engine/session.ts` → SDS §3.6; SRS FR-SESSION-RESUME, FR-SETTINGS.
- `engine/dispatcher.ts` → SDS §3.7; SRS FR-CMD-EXEC, FR-SESSION-RESUME, FR-EVENT-STREAM, FR-SETTINGS.
- `engine/ide_session.ts` → SDS §3.11; SRS FR-CMD-EXEC, FR-SESSION-RESUME, FR-EVENT-STREAM.
- `engine/settings.ts` → SDS §3.9; SRS FR-SETTINGS.
- `engine/effort.ts` → SDS §3.13; SRS FR-SETTINGS.
- `engine/log.ts` → SDS §6 (Logs); redaction covers SRS Non-Functional §4 Sec.

If this section is empty or absent, commit workflows use a default mapping:
- New/changed exports, classes, types → SDS (component section)
- New feature, CLI command, skill, agent → SRS (new FR) + SDS (new component)
- Removed feature/component → remove from SRS + SDS
- Changed behavior → SDS (update description)
- Renamed/moved modules → SDS (update paths)
- README.md → only for user-facing changes

## Documentation Rules

Your memory resets between sessions. Documentation is the only link to past decisions and context. Keeping it accurate is not optional — stale docs actively mislead future sessions.

- Follow AGENTS.md, SRS, and SDS strictly — they define what the project is and how it works.
- Workflow for changes: new or updated requirement → update SRS → update SDS → implement. Skipping steps leads to docs-code drift.
- Status markers: `[x]` = implemented, `[ ]` = pending.
- **Traceability**: Every `[x]` criterion requires evidence. Placement depends on evidence type:
  1. **Code-evidenced**: Source files contain `// FR-<ID>` (TS/JS) or `# FR-<ID>` (YAML/shell) comments near implementing logic. No paths in SRS — the code comment IS the evidence.
  2. **Non-code evidence** (benchmarks, URLs, config files without comment support, file/dir existence): Placed directly in SRS/SDS next to the criterion.
  Without evidence of either type, the criterion stays `[ ]`.

### SRS Format (`documents/requirements.md`)
```markdown
# SRS
## 1. Intro
- **Desc:**
- **Def/Abbr:**
## 2. General
- **Context:**
- **Assumptions/Constraints:**
## 3. Functional Reqs
### 3.1 FR-CMD-EXEC
- **Desc:**
- **Scenario:**
- **Acceptance:**
---

## 4. Non-Functional

- **Perf/Reliability/Sec/Scale/UX:**

## 5. Interfaces

- **API/Proto/UI:**

## 6. Acceptance

- **Criteria:**

````

### SDS Format (`documents/design.md`)
```markdown
# SDS
## 1. Intro
- **Purpose:**
- **Rel to SRS:**
## 2. Arch
- **Diagram:**
- **Subsystems:**
## 3. Components
### 3.1 Comp A
- **Purpose:**
- **Interfaces:**
- **Deps:**
...
## 4. Data
- **Entities:**
- **ERD:**
- **Migration:**
## 5. Logic
- **Algos:**
- **Rules:**
## 6. Non-Functional
- **Scale/Fault/Sec/Logs:**
## 7. Constraints
- **Simplified/Deferred:**
````

### Tasks (`documents/tasks/`)

- One file per task or session: `<YYYY-MM-DD>-<slug>.md` (kebab-case slug, max 40 chars).
- Examples: `2026-03-24-add-dark-mode.md`, `2026-03-24-fix-auth-bug.md`.
- Do not reuse another session's task file — create a new file. Old tasks provide context but may contain outdated decisions.
- Use GODS format (see below) for issues and plans.
- Directory is gitignored. Files accumulate — this is expected.

### GODS Format

```markdown
---
implements:
  - FR-XXX
---
# [Task Title]

## Goal

[Why? Business value.]

## Overview

### Context

[Full problematics, pain points, operational environment, constraints, tech debt, external URLs, @-refs to relevant files/docs.]

### Current State

[Technical description of existing system/code relevant to task.]

### Constraints

[Hard limits, anti-patterns, requirements (e.g., "Must use Deno", "No external libs").]

## Definition of Done

- [ ] [Criteria 1]
- [ ] [Criteria 2]

## Solution

[Detailed step-by-step for SELECTED variant only. Filled AFTER user selects variant.]
```

### Compressed Style Rules (All Docs)

- No changelogs — docs reflect current state, not history.
- English only (except tasks, which may use the user's language).
- Summarize by extracting facts and compressing — no loss of information, just fewer words.
- Every word must carry meaning — no filler, no fluff, no stopwords where a shorter synonym works.
- Prefer compact formats: lists, tables, YAML, Mermaid diagrams.
- Abbreviate terms after first use — define once, abbreviate everywhere.
- Use symbols and numbers to replace words where unambiguous (e.g., `→` instead of "leads to").

## Planning Rules

- **Environment Side-Effects**: When changes touch infra, databases, or external services, the plan must include migration, sync, or deploy steps — otherwise the change works locally but breaks in production.
- **Verification Steps**: Every plan must include specific verification commands (tests, validation tools, connectivity checks) — a plan without verification is just a wish.
- **Functionality Preservation**: Before editing any file for refactoring, run existing tests and confirm they pass — this is a prerequisite, not a suggestion. Without a green baseline you cannot detect regressions. Run tests again after all edits. Add new tests if coverage is missing.
- **Data-First**: When integrating with external APIs or processes, inspect the actual protocol and data formats before planning — assumptions about data shape are the #1 source of integration bugs.
- **Architectural Validation**: For complex logic changes, visualize the event sequence (sequence diagram or pseudocode) — it catches race conditions and missing edges that prose descriptions miss.
- **Variant Analysis**: When the path is non-obvious, propose variants with Pros/Cons/Risks per variant and trade-offs across them. Quality over quantity — one well-reasoned variant is fine if the path is clear.
- **Plan Persistence**: After variant selection, save the detailed plan to `documents/tasks/<YYYY-MM-DD>-<slug>.md` using GODS format — chat-only plans are lost between sessions.
- **Proactive Resolution**: Before asking the user, exhaust available resources (codebase, docs, web) to find the answer autonomously — unnecessary questions slow the workflow and signal lack of initiative.

## TDD Flow

1. **RED**: Write a failing test (`test <id>`) for new or changed logic.
2. **GREEN**: Write minimal code to pass the test.
3. **REFACTOR**: Improve code and tests without changing behavior. Re-run `test <id>`.
4. **CHECK**: Run `fmt`, `lint`, and full test suite. You are NOT done after GREEN — skipping CHECK leaves formatting errors and regressions undetected. This step is mandatory.

### Test Rules

- Test logic and behavior only — do not test constants or templates, they change without breaking anything.
- Tests live in the same package. Testing private methods is acceptable when it improves coverage of complex internals.
- Write code only to fix failing tests or reported issues — no speculative implementations.
- No stubs or mocks for internal code. Use real implementations — stubs hide integration bugs.
- Run all tests before finishing, not just the ones you changed.
- When a test fails, fix the source code — not the test. Do not modify a failing test to make it pass, do not add error swallowing or skip logic.
- Do not create source files with guessed or fabricated data to satisfy imports — if the data source is missing, that is a blocker (see Diagnosing Failures).

## Diagnosing Failures

The goal is to identify the root cause, not to suppress the symptom. A quick workaround that hides the root cause is worse than an unresolved issue with a correct diagnosis.

1. Read the relevant code and error output before making any changes.
2. Apply "5 WHY" analysis to find the root cause.
3. Root cause is fixable → apply the fix, retry.
4. Second fix attempt failed → STOP. Output "STOP-ANALYSIS REPORT" (state, expected, 5-why chain, root cause, hypotheses). Wait for user help.

When the root cause is outside your control (missing API keys/URLs, missing generator scripts, unavailable external services, wrong environment configuration) → STOP immediately and ask the user for the correct values. Do not guess, do not invent replacements, do not create workarounds.

## Development Commands

### Shell Environment
- Always use `NO_COLOR=1` when running shell commands — ANSI escape codes waste tokens and clutter output.
- When writing scripts, respect the `NO_COLOR` env var (https://no-color.org/) — disable ANSI colors when it is set.

### Standard Interface
- `check` — the main command for comprehensive project verification. Runs the following steps in parallel and fails on any non-zero:
  - code formatting check (`deno fmt --check`)
  - static code analysis (`deno lint`, strict rule set)
  - comment-scan: "TODO", "FIXME", "HACK", "XXX", debugger calls, linter and formatter suppression markers
  - typecheck all `.ts` files (`deno check`)
  - all project tests (`deno test -A`, typecheck enabled)
- `test <path>` — runs a single test file or test suite.
- `dev` — runs the application in development mode with watch mode enabled.
- `prod` — runs the application in production mode.

### Detected Commands
Configured via `deno.json` tasks (run with `deno task <name>`):
- `check` → `deno run -A scripts/check.ts` — comprehensive verification.
- `test` → `deno test -A` — full test suite.
- `dev` → `deno run -A --watch engine/cli.ts` — daemon with file watch.
- `prod` → `deno run -A engine/cli.ts` — daemon, production.
- `fmt` → `deno fmt` — formatter.

### Command Scripts
- `scripts/check.ts` — runs `deno fmt --check`, `deno lint`, comment-scan, `deno check <all .ts>`, `deno test -A` in parallel. Exits non-zero if any step fails.

## Code Documentation

- **Module level**: each module gets an `AGENTS.md` describing its responsibility and key decisions.
- **Code level**: JSDoc/GoDoc for classes, methods, and functions. Focus on *why* and *how*, not *what*. Skip trivial comments — they add noise without value.
- **Requirement traceability**: when code implements a requirement from SRS (`documents/requirements.md`), add a `// FR-<ID>` (TS/JS/Go/Rust) or `# FR-<ID>` (YAML/shell/Python) comment next to the implementing logic. Code references requirements, not the reverse — SRS must not contain file paths. Exceptions: requirements verified by benchmarks or proven by file existence need no comment.

> **Before you start:** read `documents/requirements.md` (SRS) and `documents/design.md` (SDS) if you haven't in this session. They contain project requirements and architecture that inform every task.
