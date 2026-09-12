import assert from "node:assert/strict"
import { describe, it } from "node:test"
import plugin, {
  IDENTITY_REQUEST_HOOKS,
  injectClaudeIdentity,
} from "./index.ts"
import { SYSTEM_IDENTITY } from "./transforms.ts"

type Request = Parameters<typeof injectClaudeIdentity>[0]

function request(providerID: string, system: string[]): Request {
  return {
    sessionID: "ses_test",
    model: { id: "claude-sonnet-4-6", providerID },
    system: system.map((text) => ({ type: "text", text })),
    messages: [],
    options: {},
  } as unknown as Request
}

const texts = (event: Request) => event.system.map((part) => part.text)

describe("OpenCode 2 plugin", () => {
  it("exports the V2 plugin module shape", () => {
    assert.equal(plugin.id, "griffinmartin.claude-auth")
    assert.equal(typeof plugin.setup, "function")
  })
})

describe("injectClaudeIdentity", () => {
  it("prepends the identity to an Anthropic request", () => {
    const event = request("anthropic", ["You are a helpful assistant."])
    injectClaudeIdentity(event)
    assert.deepEqual(texts(event), [
      SYSTEM_IDENTITY,
      "You are a helpful assistant.",
    ])
  })

  it("leaves requests for other providers untouched", () => {
    const event = request("openai", ["You are a helpful assistant."])
    injectClaudeIdentity(event)
    assert.deepEqual(texts(event), ["You are a helpful assistant."])
  })

  it("does not add a second copy of the identity", () => {
    const event = request("anthropic", [SYSTEM_IDENTITY, "Agent prompt"])
    injectClaudeIdentity(event)
    assert.deepEqual(texts(event), [SYSTEM_IDENTITY, "Agent prompt"])
  })

  it("recognises an identity carried inside a larger system entry", () => {
    // transformBody splits this apart later; the identity is already there,
    // so prepending a second one would duplicate it on every request.
    const event = request("anthropic", [`${SYSTEM_IDENTITY}\nAgent prompt`])
    injectClaudeIdentity(event)
    assert.deepEqual(texts(event), [`${SYSTEM_IDENTITY}\nAgent prompt`])
  })
})

describe("IDENTITY_REQUEST_HOOKS", () => {
  it("covers every request kind OpenCode dispatches to the model", () => {
    // `context` drives the agent loop; compaction, generation and title are
    // issued alongside it and bill to the same subscription. Each dispatches
    // its own hook, so one registration per kind is required.
    assert.deepEqual(
      [...IDENTITY_REQUEST_HOOKS],
      ["context", "compaction", "generate", "title"],
    )
  })
})
