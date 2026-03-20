# Changelog

## [0.7.3](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.7.2...v0.7.3) (2026-03-20)


### Bug Fixes

* handle date-suffixed model IDs and additional long context error message ([4d790a9](https://github.com/griffinmartin/opencode-claude-auth/commit/4d790a9bf0f862a1a547705ec2cd0584cf98d402))

## [0.7.2](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.7.1...v0.7.2) (2026-03-20)


### Bug Fixes

* auto-retry with beta flag fallback for long context errors ([#52](https://github.com/griffinmartin/opencode-claude-auth/issues/52)) ([a6664f4](https://github.com/griffinmartin/opencode-claude-auth/commit/a6664f461cc103c51eff9fca9ebc38aeb6e97a36)), closes [#51](https://github.com/griffinmartin/opencode-claude-auth/issues/51)

## [0.7.1](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.7.0...v0.7.1) (2026-03-20)


### Bug Fixes

* version-gate context-1m beta to opus/sonnet 4.6+ only ([#44](https://github.com/griffinmartin/opencode-claude-auth/issues/44)) ([#47](https://github.com/griffinmartin/opencode-claude-auth/issues/47)) ([75bce64](https://github.com/griffinmartin/opencode-claude-auth/commit/75bce64fef0952fe76076f4ab0b4256b60d8129a))

## [0.7.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.6.0...v0.7.0) (2026-03-20)


### Features

* add env var overrides and retry logic with backoff ([#45](https://github.com/griffinmartin/opencode-claude-auth/issues/45)) ([1335286](https://github.com/griffinmartin/opencode-claude-auth/commit/13352867a1472fe29bc859e66328ff93e75713ff))

## [0.6.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.7...v0.6.0) (2026-03-20)


### Features

* self-contained auth provider (no builtin dependency, anti-fingerprint) ([#38](https://github.com/griffinmartin/opencode-claude-auth/issues/38)) ([34ae5df](https://github.com/griffinmartin/opencode-claude-auth/commit/34ae5dfe1bbae4c57cc5be86a2dcf25579d85a06))

## [0.5.7](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.6...v0.5.7) (2026-03-20)


### Bug Fixes

* write auth.json to both Windows paths to cover all install methods ([#41](https://github.com/griffinmartin/opencode-claude-auth/issues/41)) ([a2c585a](https://github.com/griffinmartin/opencode-claude-auth/commit/a2c585a8a0ebfb7b766be19f51c39294990e11b9)), closes [#33](https://github.com/griffinmartin/opencode-claude-auth/issues/33)

## [0.5.6](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.5...v0.5.6) (2026-03-20)


### Bug Fixes

* use stable haiku alias for CLI token refresh ([#35](https://github.com/griffinmartin/opencode-claude-auth/issues/35)) ([d284762](https://github.com/griffinmartin/opencode-claude-auth/commit/d2847621bd315b2d7f5d2ae8fba8009ee6853781))

## [0.5.5](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.4...v0.5.5) (2026-03-20)


### Bug Fixes

* use LOCALAPPDATA for auth.json path on native Windows ([#30](https://github.com/griffinmartin/opencode-claude-auth/issues/30)) ([916a2fe](https://github.com/griffinmartin/opencode-claude-auth/commit/916a2fe21096e4f7d8c253a875e8b9e6aad7aab4))

## [0.5.4](https://github.com/griffinmartin/opencode-claude-auth/compare/v0.5.3...v0.5.4) (2026-03-20)


### Bug Fixes

* trigger v0.5.4 release ([0429da5](https://github.com/griffinmartin/opencode-claude-auth/commit/0429da5bb205fbf195ac87aa4cc671a0ab1e653d))
