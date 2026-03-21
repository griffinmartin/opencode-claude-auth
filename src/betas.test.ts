import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { getModelBetas, isLongContextError } from "./betas.ts"

describe("betas", () => {
  it("getModelBetas handles model-specific betas", () => {
    const sonnetBetas = getModelBetas("claude-sonnet-4-6")
    assert.ok(sonnetBetas.includes("context-1m-2025-08-07"))
    assert.ok(sonnetBetas.includes("claude-code-20250219"))

    const haikuBetas = getModelBetas("claude-haiku-4-5")
    assert.ok(!haikuBetas.includes("claude-code-20250219"))
  })

  it("getModelBetas excludes context-1m for pre-4.6 models", () => {
    const sonnet45 = getModelBetas("claude-sonnet-4-5-20250514")
    assert.ok(!sonnet45.includes("context-1m-2025-08-07"), "sonnet 4.5 should not get 1M beta")
    assert.ok(sonnet45.includes("claude-code-20250219"), "sonnet 4.5 should still get claude-code beta")

    const opus45 = getModelBetas("claude-opus-4-5-20250514")
    assert.ok(!opus45.includes("context-1m-2025-08-07"), "opus 4.5 should not get 1M beta")
  })

  it("getModelBetas excludes context-1m for date-suffixed models without minor version", () => {
    const opus4 = getModelBetas("claude-opus-4-20250514")
    assert.ok(!opus4.includes("context-1m-2025-08-07"), "opus 4 with date suffix should not get 1M beta")

    const sonnet4 = getModelBetas("claude-sonnet-4-20250514")
    assert.ok(!sonnet4.includes("context-1m-2025-08-07"), "sonnet 4 with date suffix should not get 1M beta")
  })

  it("getModelBetas excludes context-1m for unversioned aliases", () => {
    const bare = getModelBetas("sonnet")
    assert.ok(!bare.includes("context-1m-2025-08-07"), "bare 'sonnet' alias should not get 1M beta")

    const bareOpus = getModelBetas("opus")
    assert.ok(!bareOpus.includes("context-1m-2025-08-07"), "bare 'opus' alias should not get 1M beta")
  })

  it("getModelBetas filters out excluded betas when provided", () => {
    const excluded = new Set(["interleaved-thinking-2025-05-14"])
    const betas = getModelBetas("claude-sonnet-4-6", excluded)

    assert.ok(!betas.includes("interleaved-thinking-2025-05-14"), "excluded beta should be filtered out")
    assert.ok(betas.includes("context-1m-2025-08-07"), "non-excluded beta should remain")
    assert.ok(betas.includes("claude-code-20250219"), "non-excluded beta should remain")
  })

  it("getModelBetas filters out multiple excluded betas", () => {
    const excluded = new Set(["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"])
    const betas = getModelBetas("claude-sonnet-4-6", excluded)

    assert.ok(!betas.includes("interleaved-thinking-2025-05-14"), "excluded beta should be filtered out")
    assert.ok(!betas.includes("context-1m-2025-08-07"), "excluded beta should be filtered out")
    assert.ok(betas.includes("claude-code-20250219"), "non-excluded beta should remain")
  })

  it("isLongContextError detects the specific error messages", () => {
    assert.ok(
      isLongContextError("Extra usage is required for long context requests"),
      "should detect extra usage error"
    )
    assert.ok(
      isLongContextError("The long context beta is not yet available for this subscription."),
      "should detect subscription error"
    )
    assert.ok(
      isLongContextError('{"error": {"message": "Extra usage is required for long context requests"}}'),
      "should detect extra usage error in JSON"
    )
    assert.ok(
      isLongContextError('{"error": {"message": "The long context beta is not yet available for this subscription."}}'),
      "should detect subscription error in JSON"
    )
    assert.ok(
      !isLongContextError("Some other error message"),
      "should not match other errors"
    )
    assert.ok(
      !isLongContextError(""),
      "should not match empty string"
    )
  })

  it("getModelBetas uses ANTHROPIC_BETA_FLAGS when set", () => {
    process.env.ANTHROPIC_BETA_FLAGS = "custom-beta-1,custom-beta-2"
    try {
      const betas = getModelBetas("claude-sonnet-4-6")
      assert.ok(betas.includes("custom-beta-1"), "Expected custom-beta-1")
      assert.ok(betas.includes("custom-beta-2"), "Expected custom-beta-2")
      // Model-specific additions should still apply on top of overridden base
      assert.ok(betas.includes("context-1m-2025-08-07"), "Expected sonnet context-1m beta")
    } finally {
      delete process.env.ANTHROPIC_BETA_FLAGS
    }
  })
})
