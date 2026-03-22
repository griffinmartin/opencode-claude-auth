import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { getModelBetas, isLongContextError, supports1mContext } from "./betas.ts"

describe("betas", () => {
  it("getModelBetas includes standard betas for sonnet 4.6", () => {
    const sonnetBetas = getModelBetas("claude-sonnet-4-6")
    assert.ok(sonnetBetas.includes("claude-code-20250219"))
    assert.ok(!sonnetBetas.includes("context-1m-2025-08-07"), "context-1m should NOT be auto-added")
  })

  it("getModelBetas excludes claude-code beta for haiku", () => {
    const haikuBetas = getModelBetas("claude-haiku-4-5")
    assert.ok(!haikuBetas.includes("claude-code-20250219"))
  })

  it("getModelBetas does not auto-add context-1m for any model by default", () => {
    const models = [
      "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5-20250514",
      "claude-opus-4-5-20250514", "claude-opus-4-20250514", "sonnet", "opus",
    ]
    for (const model of models) {
      const betas = getModelBetas(model)
      assert.ok(!betas.includes("context-1m-2025-08-07"), `${model} should not get 1M beta by default`)
    }
  })

  it("getModelBetas adds context-1m when ANTHROPIC_ENABLE_1M_CONTEXT=true for 4.6+ models", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true"
    try {
      const sonnet = getModelBetas("claude-sonnet-4-6")
      assert.ok(sonnet.includes("context-1m-2025-08-07"), "sonnet 4.6 should get 1M beta when opted in")

      const opus = getModelBetas("claude-opus-4-6")
      assert.ok(opus.includes("context-1m-2025-08-07"), "opus 4.6 should get 1M beta when opted in")
    } finally {
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    }
  })

  it("getModelBetas does not add context-1m with opt-in for pre-4.6 models", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true"
    try {
      const sonnet45 = getModelBetas("claude-sonnet-4-5-20250514")
      assert.ok(!sonnet45.includes("context-1m-2025-08-07"), "sonnet 4.5 should not get 1M beta even when opted in")

      const opus45 = getModelBetas("claude-opus-4-5-20250514")
      assert.ok(!opus45.includes("context-1m-2025-08-07"), "opus 4.5 should not get 1M beta even when opted in")

      const bare = getModelBetas("sonnet")
      assert.ok(!bare.includes("context-1m-2025-08-07"), "bare alias should not get 1M beta even when opted in")
    } finally {
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    }
  })

  it("supports1mContext identifies eligible models", () => {
    assert.ok(supports1mContext("claude-sonnet-4-6"), "sonnet 4.6 supports 1M")
    assert.ok(supports1mContext("claude-opus-4-6"), "opus 4.6 supports 1M")
    assert.ok(!supports1mContext("claude-sonnet-4-5-20250514"), "sonnet 4.5 does not support 1M")
    assert.ok(!supports1mContext("claude-opus-4-20250514"), "opus 4 with date suffix does not support 1M")
    assert.ok(!supports1mContext("sonnet"), "bare alias does not support 1M")
    assert.ok(!supports1mContext("claude-haiku-4-5"), "haiku does not support 1M")
  })

  it("getModelBetas filters out excluded betas when provided", () => {
    const excluded = new Set(["interleaved-thinking-2025-05-14"])
    const betas = getModelBetas("claude-sonnet-4-6", excluded)

    assert.ok(!betas.includes("interleaved-thinking-2025-05-14"), "excluded beta should be filtered out")
    assert.ok(betas.includes("claude-code-20250219"), "non-excluded beta should remain")
  })

  it("getModelBetas filters out multiple excluded betas", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true"
    try {
      const excluded = new Set(["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"])
      const betas = getModelBetas("claude-sonnet-4-6", excluded)

      assert.ok(!betas.includes("interleaved-thinking-2025-05-14"), "excluded beta should be filtered out")
      assert.ok(!betas.includes("context-1m-2025-08-07"), "excluded beta should be filtered out")
      assert.ok(betas.includes("claude-code-20250219"), "non-excluded beta should remain")
    } finally {
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    }
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
      assert.ok(!betas.includes("context-1m-2025-08-07"), "context-1m should not be auto-added even with custom flags")
    } finally {
      delete process.env.ANTHROPIC_BETA_FLAGS
    }
  })

  it("getModelBetas adds context-1m with ANTHROPIC_BETA_FLAGS and opt-in combined", () => {
    process.env.ANTHROPIC_BETA_FLAGS = "custom-beta-1"
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true"
    try {
      const betas = getModelBetas("claude-sonnet-4-6")
      assert.ok(betas.includes("custom-beta-1"), "Expected custom beta")
      assert.ok(betas.includes("context-1m-2025-08-07"), "Expected 1M beta with opt-in")
    } finally {
      delete process.env.ANTHROPIC_BETA_FLAGS
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    }
  })
})
