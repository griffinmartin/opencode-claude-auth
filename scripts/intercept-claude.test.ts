import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, beforeEach, afterEach } from "node:test"
import { updateModelConfig } from "./intercept-claude.ts"

const TEMPLATE = `export interface ModelOverride {
  exclude?: string[]
  add?: string[]
}

export interface ModelConfig {
  ccVersion: string
  baseBetas: string[]
  longContextBetas: string[]
  modelOverrides: Record<string, ModelOverride>
}

export const config: ModelConfig = {
  ccVersion: "2.1.80",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
  ],
  longContextBetas: [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
  ],
  modelOverrides: {
    "4-6": {
      add: ["effort-2025-11-24"],
    },
  },
}
`

describe("updateModelConfig", () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "intercept-test-"))
    configPath = join(tmpDir, "model-config.ts")
    writeFileSync(configPath, TEMPLATE, "utf-8")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("updates baseBetas array", () => {
    updateModelConfig(
      {
        newBaseBetas: ["beta-a", "beta-b", "beta-c"],
      },
      configPath,
    )
    const result = readFileSync(configPath, "utf-8")
    assert.ok(result.includes('"beta-a"'), "should contain beta-a")
    assert.ok(result.includes('"beta-b"'), "should contain beta-b")
    assert.ok(result.includes('"beta-c"'), "should contain beta-c")
    assert.ok(
      !result.includes('"claude-code-20250219"'),
      "should not contain old beta",
    )
  })

  it("updates ccVersion", () => {
    updateModelConfig(
      {
        newCcVersion: "3.0.0",
      },
      configPath,
    )
    const result = readFileSync(configPath, "utf-8")
    assert.ok(result.includes('ccVersion: "3.0.0"'), "should have new version")
    assert.ok(
      !result.includes('ccVersion: "2.1.80"'),
      "should not have old version",
    )
  })

  it("updates existing model override", () => {
    const diffs = new Map<string, { added: string[]; removed: string[] }>()
    diffs.set("claude-sonnet-4-6", {
      added: ["new-beta-2025"],
      removed: [],
    })

    updateModelConfig(
      {
        modelBetaDiffs: diffs,
      },
      configPath,
    )
    const result = readFileSync(configPath, "utf-8")
    assert.ok(
      result.includes('"new-beta-2025"'),
      "should contain the new model-specific beta",
    )
    // Should still have the existing add
    assert.ok(
      result.includes('"effort-2025-11-24"'),
      "should preserve existing override beta",
    )
  })

  it("adds new model override when none exists", () => {
    const diffs = new Map<string, { added: string[]; removed: string[] }>()
    diffs.set("claude-haiku-4-5", {
      added: ["haiku-special-beta"],
      removed: [],
    })

    updateModelConfig(
      {
        modelBetaDiffs: diffs,
      },
      configPath,
    )
    const result = readFileSync(configPath, "utf-8")
    assert.ok(result.includes("haiku"), "should have new haiku override key")
    assert.ok(
      result.includes('"haiku-special-beta"'),
      "should contain the haiku-specific beta",
    )
  })

  it("applies all updates together", () => {
    const diffs = new Map<string, { added: string[]; removed: string[] }>()
    diffs.set("claude-sonnet-4-6", {
      added: ["streaming-beta"],
      removed: [],
    })

    updateModelConfig(
      {
        newBaseBetas: ["alpha", "bravo"],
        newCcVersion: "5.0.0",
        modelBetaDiffs: diffs,
      },
      configPath,
    )
    const result = readFileSync(configPath, "utf-8")
    assert.ok(result.includes('"alpha"'), "should have new base beta")
    assert.ok(result.includes('"bravo"'), "should have new base beta")
    assert.ok(result.includes('ccVersion: "5.0.0"'), "should have new version")
    assert.ok(
      result.includes('"streaming-beta"'),
      "should have model-specific beta",
    )
  })

  it("preserves file structure outside of updated sections", () => {
    updateModelConfig(
      {
        newCcVersion: "9.9.9",
      },
      configPath,
    )
    const result = readFileSync(configPath, "utf-8")
    assert.ok(
      result.includes("export interface ModelOverride"),
      "should preserve interfaces",
    )
    assert.ok(
      result.includes("export interface ModelConfig"),
      "should preserve interfaces",
    )
    assert.ok(
      result.includes("longContextBetas"),
      "should preserve longContextBetas",
    )
    assert.ok(
      result.includes("export const config"),
      "should preserve export statement",
    )
  })

  it("handles empty updates without modifying file", () => {
    updateModelConfig({}, configPath)
    const result = readFileSync(configPath, "utf-8")
    assert.equal(result, TEMPLATE, "file should be unchanged")
  })
})
