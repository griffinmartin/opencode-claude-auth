# Changelog

## [1.4.7](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.4.6...v1.4.7) (2026-04-05)


### Bug Fixes

* repair orphaned tool_use/tool_result pairs before API request ([#136](https://github.com/griffinmartin/opencode-claude-auth/issues/136)) ([ceaf742](https://github.com/griffinmartin/opencode-claude-auth/commit/ceaf742c6249a898fcf5617383e6c1a6a71770e5)), closes [#133](https://github.com/griffinmartin/opencode-claude-auth/issues/133)

## [1.4.6](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.4.5...v1.4.6) (2026-04-04)


### Bug Fixes

* avoid duplicating cache_control when splitting identity system entry ([#131](https://github.com/griffinmartin/opencode-claude-auth/issues/131)) ([adcfd61](https://github.com/griffinmartin/opencode-claude-auth/commit/adcfd61b62401b82bc65bd34b7b2276ebd89ae2f))

## [1.4.5](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.4.4...v1.4.5) (2026-04-04)


### Bug Fixes

* strip effort parameter from request body for haiku models ([#126](https://github.com/griffinmartin/opencode-claude-auth/issues/126)) ([d163938](https://github.com/griffinmartin/opencode-claude-auth/commit/d1639387ca35391c6516f79d7121dad33544f69b))
* use Object.keys guard for thinking cleanup instead of budget_tokens sentinel ([#129](https://github.com/griffinmartin/opencode-claude-auth/issues/129)) ([174875a](https://github.com/griffinmartin/opencode-claude-auth/commit/174875acbad15b9ea6fc37fdb37872516664ef2d))

## [1.4.4](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.4.3...v1.4.4) (2026-04-03)


### Bug Fixes

* exclude interleaved-thinking beta for haiku models ([#120](https://github.com/griffinmartin/opencode-claude-auth/issues/120)) ([de5d806](https://github.com/griffinmartin/opencode-claude-auth/commit/de5d806b995a31d5840c11a0cac1198e08eafbea))

## [1.4.3](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.4.2...v1.4.3) (2026-04-03)


### Bug Fixes

* compute CCH signing for billing header, fix system prompt splitting ([#116](https://github.com/griffinmartin/opencode-claude-auth/issues/116)) ([f2e101a](https://github.com/griffinmartin/opencode-claude-auth/commit/f2e101ae241388d3e2e1fd747230d6ce73d34b75))

## [1.4.2](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.4.1...v1.4.2) (2026-03-31)


### Bug Fixes

* add missing API request headers for parity with Claude Code ([#109](https://github.com/griffinmartin/opencode-claude-auth/issues/109)) ([5d6455d](https://github.com/griffinmartin/opencode-claude-auth/commit/5d6455da3c41e40f16c65e7378eb31d500da27b7))

## [1.4.1](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.4.0...v1.4.1) (2026-03-31)


### Bug Fixes

* register transform hook even when no OAuth accounts exist ([#111](https://github.com/griffinmartin/opencode-claude-auth/issues/111)) ([ac8b780](https://github.com/griffinmartin/opencode-claude-auth/commit/ac8b7808183561b6c7b9fde8bcdb1b930b9993bb))

## [1.4.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.3.5...v1.4.0) (2026-03-31)


### Features

* config file alternative for 1M context setting ([#90](https://github.com/griffinmartin/opencode-claude-auth/issues/90)) ([d27382f](https://github.com/griffinmartin/opencode-claude-auth/commit/d27382f59b17b172b6c33831e585a25e21ab943f))

## [1.3.5](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.3.4...v1.3.5) (2026-03-31)


### Bug Fixes

* eliminate idle token consumption via direct OAuth refresh ([#104](https://github.com/griffinmartin/opencode-claude-auth/issues/104)) ([e7483d7](https://github.com/griffinmartin/opencode-claude-auth/commit/e7483d7108d1d00f4bccc11d540fb375d7361d5f))

## [1.3.4](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.3.3...v1.3.4) (2026-03-30)


### Bug Fixes

* add exports["./server"] for opencode 1.3.8 plugin loader compatibility ([#102](https://github.com/griffinmartin/opencode-claude-auth/issues/102)) ([efecefd](https://github.com/griffinmartin/opencode-claude-auth/commit/efecefda9fd7d63b8c42466a6277fc03b0057faa))

## [1.3.3](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.3.2...v1.3.3) (2026-03-27)


### Bug Fixes

* run CLI token refresh in tmpdir instead of inheriting cwd ([#96](https://github.com/griffinmartin/opencode-claude-auth/issues/96)) ([7db98a1](https://github.com/griffinmartin/opencode-claude-auth/commit/7db98a1e36fd8ffd775e14c2bd6c4f76c7a141b8))

## [1.3.2](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.3.1...v1.3.2) (2026-03-26)


### Bug Fixes

* add logging to refresh failure path for diagnostics ([#94](https://github.com/griffinmartin/opencode-claude-auth/issues/94)) ([5d80a59](https://github.com/griffinmartin/opencode-claude-auth/commit/5d80a59be04fb385941f7c20349746b69b7a2393))

## [1.3.1](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.3.0...v1.3.1) (2026-03-25)


### Bug Fixes

* add debug logger for auth flow diagnostics ([#84](https://github.com/griffinmartin/opencode-claude-auth/issues/84)) ([#85](https://github.com/griffinmartin/opencode-claude-auth/issues/85)) ([0fc246a](https://github.com/griffinmartin/opencode-claude-auth/commit/0fc246a4362f642c5f0be59b31d3b9430c0d1869))

## [1.3.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.2.0...v1.3.0) (2026-03-24)


### Features

* model config refactor and Claude CLI intercept script ([#78](https://github.com/griffinmartin/opencode-claude-auth/issues/78)) ([89f23fe](https://github.com/griffinmartin/opencode-claude-auth/commit/89f23fec38810e4839cfb576d94f21da1330886d))

## [1.2.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.1.1...v1.2.0) (2026-03-24)


### Features

* macOS support multiple Claude Code accounts from keychain ([#63](https://github.com/griffinmartin/opencode-claude-auth/issues/63)) ([4594b36](https://github.com/griffinmartin/opencode-claude-auth/commit/4594b36f2c732d6a27ccd798112019ea4bc748b8))

## [1.1.1](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.1.0...v1.1.1) (2026-03-23)


### Bug Fixes

* exclude CHANGELOG.md from oxfmt formatting checks ([ddcd97e](https://github.com/griffinmartin/opencode-claude-auth/commit/ddcd97e99864ca434cb3f9961802ae4567b5aef5))

## [1.1.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v1.0.0...v1.1.0) (2026-03-22)


### Features

* add Homebrew formula for brew install support ([#68](https://github.com/griffinmartin/opencode-claude-auth/issues/68)) ([6beb56e](https://github.com/griffinmartin/opencode-claude-auth/commit/6beb56e7f56da35d9fa5724d9cc7d86d4b590c51))

## [1.0.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.7.4...v1.0.0) (2026-03-22)

### ⚠ BREAKING CHANGES

- context-1m-2025-08-07 is no longer sent by default. Claude Max users who relied on automatic 1M context must set the env var.

### Bug Fixes

- make context-1m beta opt-in to fix long context billing errors ([#64](https://github.com/griffinmartin/opencode-claude-auth/issues/64)) ([#65](https://github.com/griffinmartin/opencode-claude-auth/issues/65)) ([f8cb63d](https://github.com/griffinmartin/opencode-claude-auth/commit/f8cb63d69dab178dc3fe9ca4bf7d849e7d0a661a))

## [0.7.4](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.7.3...v0.7.4) (2026-03-21)

### Bug Fixes

- restore package root shim for plugin resolution ([#61](https://github.com/griffinmartin/opencode-claude-auth/issues/61)) ([cc02950](https://github.com/griffinmartin/opencode-claude-auth/commit/cc02950d789f24bf29b99a33efc13a8dca7a535e))

## [0.7.3](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.7.2...v0.7.3) (2026-03-20)

### Bug Fixes

- handle date-suffixed model IDs and additional long context error message ([4d790a9](https://github.com/griffinmartin/opencode-claude-auth/commit/4d790a9bf0f862a1a547705ec2cd0584cf98d402))

## [0.7.2](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.7.1...v0.7.2) (2026-03-20)

### Bug Fixes

- auto-retry with beta flag fallback for long context errors ([#52](https://github.com/griffinmartin/opencode-claude-auth/issues/52)) ([a6664f4](https://github.com/griffinmartin/opencode-claude-auth/commit/a6664f461cc103c51eff9fca9ebc38aeb6e97a36)), closes [#51](https://github.com/griffinmartin/opencode-claude-auth/issues/51)

## [0.7.1](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.7.0...v0.7.1) (2026-03-20)

### Bug Fixes

- version-gate context-1m beta to opus/sonnet 4.6+ only ([#44](https://github.com/griffinmartin/opencode-claude-auth/issues/44)) ([#47](https://github.com/griffinmartin/opencode-claude-auth/issues/47)) ([75bce64](https://github.com/griffinmartin/opencode-claude-auth/commit/75bce64fef0952fe76076f4ab0b4256b60d8129a))

## [0.7.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.6.0...v0.7.0) (2026-03-20)

### Features

- add env var overrides and retry logic with backoff ([#45](https://github.com/griffinmartin/opencode-claude-auth/issues/45)) ([1335286](https://github.com/griffinmartin/opencode-claude-auth/commit/13352867a1472fe29bc859e66328ff93e75713ff))

## [0.6.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.7...v0.6.0) (2026-03-20)

### Features

- self-contained auth provider (no builtin dependency, anti-fingerprint) ([#38](https://github.com/griffinmartin/opencode-claude-auth/issues/38)) ([34ae5df](https://github.com/griffinmartin/opencode-claude-auth/commit/34ae5dfe1bbae4c57cc5be86a2dcf25579d85a06))

## [0.5.7](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.6...v0.5.7) (2026-03-20)

### Bug Fixes

- write auth.json to both Windows paths to cover all install methods ([#41](https://github.com/griffinmartin/opencode-claude-auth/issues/41)) ([a2c585a](https://github.com/griffinmartin/opencode-claude-auth/commit/a2c585a8a0ebfb7b766be19f51c39294990e11b9)), closes [#33](https://github.com/griffinmartin/opencode-claude-auth/issues/33)

## [0.5.6](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.5...v0.5.6) (2026-03-20)

### Bug Fixes

- use stable haiku alias for CLI token refresh ([#35](https://github.com/griffinmartin/opencode-claude-auth/issues/35)) ([d284762](https://github.com/griffinmartin/opencode-claude-auth/commit/d2847621bd315b2d7f5d2ae8fba8009ee6853781))

## [0.5.5](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.4...v0.5.5) (2026-03-20)

### Bug Fixes

- use LOCALAPPDATA for auth.json path on native Windows ([#30](https://github.com/griffinmartin/opencode-claude-auth/issues/30)) ([916a2fe](https://github.com/griffinmartin/opencode-claude-auth/commit/916a2fe21096e4f7d8c253a875e8b9e6aad7aab4))

## [0.5.4](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.3...v0.5.4) (2026-03-20)

### Bug Fixes

- trigger v0.5.4 release ([0429da5](https://github.com/griffinmartin/opencode-claude-auth/commit/0429da5bb205fbf195ac87aa4cc671a0ab1e653d))
