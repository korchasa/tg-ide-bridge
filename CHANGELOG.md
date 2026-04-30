# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.1.6](https://github.com/korchasa/tg-ide-bridge/compare/v0.1.5...v0.1.6) (2026-04-30)


### Features

* **engine:** codex /effort via typed reasoningEffort, ai-ide-cli 0.5.8 ([191f8d4](https://github.com/korchasa/tg-ide-bridge/commit/191f8d4dcbdaa8f536522081eec50a9501537841))
* **engine:** widen JSR exports for library-mode embedding ([1cddb6c](https://github.com/korchasa/tg-ide-bridge/commit/1cddb6cd79360d011febbec87f182e0a14e254fe)), closes [#1](https://github.com/korchasa/tg-ide-bridge/issues/1)


### Documentation

* **agents:** note CLAUDE.md symlink and Homebrew PATH workaround ([917b0de](https://github.com/korchasa/tg-ide-bridge/commit/917b0de685c3d124a355b9501ec2d45381c029ec))

### [0.1.5](https://github.com/korchasa/tg-ide-bridge/compare/v0.1.4...v0.1.5) (2026-04-26)


### Bug Fixes

* **format:** prevent malformed HTML from cross-tag inline matches ([fb884f8](https://github.com/korchasa/tg-ide-bridge/commit/fb884f833a4d1b4c6e65e68f427d2788a8a3895d))

### [0.1.4](https://github.com/korchasa/tg-ide-bridge/compare/v0.1.3...v0.1.4) (2026-04-25)


### Bug Fixes

* **capabilities:** force maxRetries>=1 around fetchCapabilitiesSlow ([3b92c15](https://github.com/korchasa/tg-ide-bridge/commit/3b92c15ef418d10b408c15695ef5635bb7d58a48))

### [0.1.3](https://github.com/korchasa/tg-ide-bridge/compare/v0.1.2...v0.1.3) (2026-04-25)


### Features

* **capabilities:** expose IDE skills/commands as TG slash commands ([dcad1c3](https://github.com/korchasa/tg-ide-bridge/commit/dcad1c3558ff5c61d98cf41e651a82b2638a09ce))
* **engine:** adopt ai-ide-cli 0.5.3 with session-mode + codex IDE ([9e4826e](https://github.com/korchasa/tg-ide-bridge/commit/9e4826ebd22cc248119f7c214ff3a3bb539484d8))


### Build System

* **check:** enforce strict typecheck and stricter lint rules ([a5a29da](https://github.com/korchasa/tg-ide-bridge/commit/a5a29daf583b7859cf7308692346c1cc1ead3c72))


### Tests

* **e2e:** real-IDE end-to-end suite against actual CLI binaries ([d8f10c1](https://github.com/korchasa/tg-ide-bridge/commit/d8f10c1a4097ae9fc2a31bf32c4a9b712fc1245a))

### [0.1.2](https://github.com/korchasa/tg-ide-bridge/compare/v0.1.1...v0.1.2) (2026-04-19)


### Build System

* **ci:** bump action and Deno versions to latest ([9d081da](https://github.com/korchasa/tg-ide-bridge/commit/9d081da1560fde75d3a4b7ff1918e171cd761cf6))

### 0.1.1 (2026-04-19)


### Features

* initial tg-ide-bridge daemon v1 ([21f555a](https://github.com/korchasa/tg-ide-bridge/commit/21f555a5c6fb489e41c9136e1694ae40ba4fdf4b))
* **streamer:** render final assistant text as native TG HTML ([5668549](https://github.com/korchasa/tg-ide-bridge/commit/5668549469b8b1bfd7d35e83bccf55825395b57e))
* **streamer:** rich event rendering with emoji + <code>-wrapped args ([c29c417](https://github.com/korchasa/tg-ide-bridge/commit/c29c41768d3b4ca3c4dcc86c26aa2f1f78b22008))
* **streamer:** strip `text:` prefix, drop OK success marker ([6666694](https://github.com/korchasa/tg-ide-bridge/commit/66666941d1ed90d7b536b1dcfae791b706f76010))


### Bug Fixes

* **ci:** gate release on commit subject, not body ([8789345](https://github.com/korchasa/tg-ide-bridge/commit/8789345205f4abfcb5b519bc00b2b8a65b5febe4))


### Continuous Integration

* add build and release pipeline with JSR publishing ([969a3f4](https://github.com/korchasa/tg-ide-bridge/commit/969a3f4c67cbf758e29762547f25221c39282d70))
