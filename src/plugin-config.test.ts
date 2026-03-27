import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"
import {
  applyOpencodeConfig,
  isEnable1mContext,
  resetPluginSettings,
  getPluginSettings,
} from "./plugin-config.ts"

describe("plugin-config", () => {
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    resetPluginSettings()
  })

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.ANTHROPIC_ENABLE_1M_CONTEXT = savedEnv
    } else {
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    }
    resetPluginSettings()
  })

  describe("isEnable1mContext", () => {
    it("returns false by default when neither env nor config is set", () => {
      assert.equal(isEnable1mContext(), false)
    })

    it("returns true when env var is set to 'true'", () => {
      process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true"
      assert.equal(isEnable1mContext(), true)
    })

    it("returns false when env var is set to 'false'", () => {
      process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "false"
      assert.equal(isEnable1mContext(), false)
    })

    it("returns true when config sets enable1mContext", () => {
      applyOpencodeConfig({
        agent: { build: { enable1mContext: true } },
      })
      assert.equal(isEnable1mContext(), true)
    })

    it("env var overrides config (env=false, config=true)", () => {
      applyOpencodeConfig({
        agent: { build: { enable1mContext: true } },
      })
      process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "false"
      assert.equal(isEnable1mContext(), false)
    })

    it("env var overrides config (env=true, config=false)", () => {
      applyOpencodeConfig({
        agent: { build: { enable1mContext: false } },
      })
      process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true"
      assert.equal(isEnable1mContext(), true)
    })
  })

  describe("applyOpencodeConfig", () => {
    it("reads enable1mContext from agent.build", () => {
      applyOpencodeConfig({
        agent: { build: { enable1mContext: true } },
      })
      assert.equal(getPluginSettings().enable1mContext, true)
    })

    it("reads enable1mContext from any agent config", () => {
      applyOpencodeConfig({
        agent: { plan: { enable1mContext: true } },
      })
      assert.equal(getPluginSettings().enable1mContext, true)
    })

    it("ignores non-object config", () => {
      applyOpencodeConfig(null)
      applyOpencodeConfig(undefined)
      applyOpencodeConfig("string")
      applyOpencodeConfig(42)
      assert.equal(getPluginSettings().enable1mContext, undefined)
    })

    it("ignores config without agent field", () => {
      applyOpencodeConfig({ plugin: ["opencode-claude-auth"] })
      assert.equal(getPluginSettings().enable1mContext, undefined)
    })

    it("ignores non-boolean enable1mContext values", () => {
      applyOpencodeConfig({
        agent: { build: { enable1mContext: "true" } },
      })
      assert.equal(getPluginSettings().enable1mContext, undefined)
    })

    it("takes first boolean value found in iteration order", () => {
      applyOpencodeConfig({
        agent: {
          build: { enable1mContext: true },
          plan: { enable1mContext: false },
        },
      })
      assert.equal(getPluginSettings().enable1mContext, true)
    })
  })

  describe("resetPluginSettings", () => {
    it("clears all settings", () => {
      applyOpencodeConfig({
        agent: { build: { enable1mContext: true } },
      })
      assert.equal(getPluginSettings().enable1mContext, true)
      resetPluginSettings()
      assert.equal(getPluginSettings().enable1mContext, undefined)
    })
  })
})
