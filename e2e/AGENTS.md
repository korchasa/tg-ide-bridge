# e2e/

Real-IDE end-to-end tests. Drives the actual `claude` / `opencode` /
`cursor` / `codex` CLI binaries through the production `SessionManager`
+ `Streamer` with a faked Telegram Bot API.

Isolation:

- Run only via `deno task e2e`. Excluded from `deno task test` and
  `deno task check` via `--ignore=e2e/` so the default gate stays
  hermetic and free.
- IDEs without a locally available binary are recorded as `ignored` via a
  top-level `await probeAllIdes()` + `Deno.test({ ignore: … })`.
- IDEs without local auth are also recorded as `ignored` via cheap CLI
  status probes (`claude auth status`, `codex login status`,
  `cursor agent status`, `opencode providers list`).

Files:

- `harness.ts` — `buildHarness`, `ideSkipReason`, `probeAllIdes`,
  `testPerIde`. Imports `SessionManager` / `Streamer` / `SessionStore`
  from `../engine/` by relative path.
- `ide_e2e_test.ts` — three contract-level tests parametrized over
  every entry in `SUPPORTED_IDES`: basic prompt, resume across two
  turns, `/stop` abort.
