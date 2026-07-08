import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getModelBetas, isLongContextError } from "./betas.ts"
import { config, getModelOverride } from "./model-config.ts"

describe("betas", () => {
  it("getModelBetas includes all baseBetas from config for sonnet 4.6", () => {
    const sonnetBetas = getModelBetas("claude-sonnet-4-6")
    for (const beta of config.baseBetas) {
      assert.ok(
        sonnetBetas.includes(beta),
        `sonnet 4.6 should include base beta: ${beta}`,
      )
    }
    // Model-specific overrides should also be applied
    const override = getModelOverride("claude-sonnet-4-6")
    if (override?.add) {
      for (const beta of override.add) {
        assert.ok(
          sonnetBetas.includes(beta),
          `sonnet 4.6 should include override beta: ${beta}`,
        )
      }
    }
  })

  it("getModelBetas includes non-excluded baseBetas for haiku", () => {
    const haikuBetas = getModelBetas("claude-haiku-4-5")
    const override = getModelOverride("claude-haiku-4-5")
    for (const beta of config.baseBetas) {
      if (override?.exclude?.includes(beta)) {
        assert.ok(
          !haikuBetas.includes(beta),
          `haiku should exclude overridden beta: ${beta}`,
        )
      } else {
        assert.ok(
          haikuBetas.includes(beta),
          `haiku should include base beta: ${beta}`,
        )
      }
    }
  })

  it("getModelBetas excludes interleaved-thinking for haiku models", () => {
    const models = ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]
    for (const model of models) {
      const betas = getModelBetas(model)
      assert.ok(
        !betas.includes("interleaved-thinking-2025-05-14"),
        `${model} should not include interleaved-thinking beta`,
      )
      assert.ok(
        betas.includes("claude-code-20250219"),
        `${model} should still include claude-code beta`,
      )
      assert.ok(
        betas.includes("oauth-2025-04-20"),
        `${model} should still include oauth beta`,
      )
    }
  })

  it("getModelOverride sets disableEffort for haiku models", () => {
    for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
      const override = getModelOverride(model)
      assert.ok(override, `${model} should have a model override`)
      assert.equal(
        override!.disableEffort,
        true,
        `${model} should have disableEffort set`,
      )
    }
  })

  it("getModelOverride does not set disableEffort for non-haiku models", () => {
    for (const model of [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
    ]) {
      const override = getModelOverride(model)
      assert.ok(
        !override?.disableEffort,
        `${model} should not have disableEffort`,
      )
    }
  })

  it("getModelBetas applies model overrides from config", () => {
    for (const [pattern, override] of Object.entries(config.modelOverrides)) {
      // Use a realistic model ID that matches the pattern
      const modelId = `claude-${pattern}-test`
      const betas = getModelBetas(modelId)
      if (override.exclude) {
        for (const ex of override.exclude) {
          assert.ok(!betas.includes(ex), `${modelId} should exclude: ${ex}`)
        }
      }
      if (override.add) {
        for (const add of override.add) {
          assert.ok(betas.includes(add), `${modelId} should include: ${add}`)
        }
      }
    }
  })

  it("getModelBetas filters out excluded betas when provided", () => {
    const betaToExclude = config.baseBetas[config.baseBetas.length - 1]
    const betaToKeep = config.baseBetas[0]
    const excluded = new Set([betaToExclude])
    const betas = getModelBetas("claude-sonnet-4-6", excluded)

    assert.ok(
      !betas.includes(betaToExclude),
      `excluded beta ${betaToExclude} should be filtered out`,
    )
    assert.ok(
      betas.includes(betaToKeep),
      `non-excluded beta ${betaToKeep} should remain`,
    )
  })

  it("getModelBetas filters out multiple excluded betas", () => {
    const excluded = new Set(config.longContextBetas)
    const betas = getModelBetas("claude-sonnet-4-6", excluded)

    for (const ex of config.longContextBetas) {
      assert.ok(
        !betas.includes(ex),
        `excluded beta ${ex} should be filtered out`,
      )
    }
    assert.ok(
      betas.includes(config.baseBetas[0]),
      `non-excluded beta ${config.baseBetas[0]} should remain`,
    )
  })

  it("isLongContextError detects the specific error messages", () => {
    assert.ok(
      isLongContextError("Extra usage is required for long context requests"),
      "should detect extra usage error",
    )
    assert.ok(
      isLongContextError(
        "The long context beta is not yet available for this subscription.",
      ),
      "should detect subscription error",
    )
    assert.ok(
      isLongContextError(
        '{"error": {"message": "Extra usage is required for long context requests"}}',
      ),
      "should detect extra usage error in JSON",
    )
    assert.ok(
      isLongContextError(
        '{"error": {"message": "The long context beta is not yet available for this subscription."}}',
      ),
      "should detect subscription error in JSON",
    )
    assert.ok(
      !isLongContextError("Some other error message"),
      "should not match other errors",
    )
    assert.ok(!isLongContextError(""), "should not match empty string")
  })

  it("isLongContextError detects out-of-extra-usage error (Max subscription quota)", () => {
    assert.ok(
      isLongContextError("You're out of extra usage"),
      "should detect out-of-extra-usage error",
    )
    assert.ok(
      isLongContextError(
        "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
      ),
      "should detect full out-of-extra-usage message",
    )
    assert.ok(
      isLongContextError(
        '{"error": {"message": "You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}',
      ),
      "should detect out-of-extra-usage error in JSON",
    )
  })

  it("getModelBetas uses ANTHROPIC_BETA_FLAGS when set", () => {
    process.env.ANTHROPIC_BETA_FLAGS = "custom-beta-1,custom-beta-2"
    try {
      const betas = getModelBetas("claude-sonnet-4-6")
      assert.ok(betas.includes("custom-beta-1"), "Expected custom-beta-1")
      assert.ok(betas.includes("custom-beta-2"), "Expected custom-beta-2")
    } finally {
      delete process.env.ANTHROPIC_BETA_FLAGS
    }
  })

  it("getModelBetas override exclusion removes duplicate occurrences", () => {
    // Regenerated configs can list the same beta twice; excluding it must
    // remove every occurrence, not just the first.
    process.env.ANTHROPIC_BETA_FLAGS =
      "interleaved-thinking-2025-05-14,custom-beta-1,interleaved-thinking-2025-05-14"
    try {
      const betas = getModelBetas("claude-haiku-4-5")
      assert.ok(
        !betas.includes("interleaved-thinking-2025-05-14"),
        "haiku should exclude every occurrence of interleaved-thinking",
      )
      assert.ok(betas.includes("custom-beta-1"), "unrelated beta should remain")
    } finally {
      delete process.env.ANTHROPIC_BETA_FLAGS
    }
  })
})
