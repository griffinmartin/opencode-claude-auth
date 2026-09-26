import assert from "node:assert/strict"
import { describe, it } from "node:test"
import plugin, {
  IDENTITY_REQUEST_HOOKS,
  injectClaudeIdentity,
} from "./index.ts"
import { CLAUDE_CODE_OAUTH_METADATA_KEY, METHOD_ID } from "./oauth-method.ts"
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

function nativeRequest() {
  return new globalThis.Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "sk-test" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
  })
}

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

describe("native provider HTTP hooks", () => {
  it("keeps native model packages and only adjusts subscription requests", async () => {
    const hooks = new Map<string, (event: any) => Promise<void>>()
    let credential: any = { type: "key", key: "sk-test" }
    const provider = {
      package: "@opencode/ai/providers/anthropic",
      name: "Anthropic",
    }
    const model = { package: "@opencode/ai/providers/anthropic", cost: [1] }
    const ctx = {
      integration: {
        transform: async () => {},
        connection: {
          active: async () => ({ type: "credential", id: "test" }),
          resolve: async () => credential,
        },
      },
      provider: {
        transform: async (edit: any) =>
          edit({
            get: () => ({ models: new Map([["claude-sonnet-4-6", model]]) }),
            update: (_id: string, change: (value: typeof provider) => void) =>
              change(provider),
            models: {
              update: (
                _id: string,
                _model: string,
                change: (value: typeof model) => void,
              ) => change(model),
            },
          }),
        reload: async () => {},
      },
      event: { subscribe: async function* () {} },
      session: {
        hook: async (kind: string, hook: (event: any) => Promise<void>) => {
          hooks.set(kind, hook)
        },
      },
    }
    const dispose = await plugin.setup(ctx as never)
    try {
      assert.equal(provider.package, "@opencode/ai/providers/anthropic")
      assert.equal(model.package, "@opencode/ai/providers/anthropic")
      const event = {
        model: { providerID: "anthropic" },
        request: nativeRequest(),
      }
      await hooks.get("http.request")!(event)
      assert.equal(event.request.headers.get("x-api-key"), "sk-test")
      assert.equal(event.request.headers.has("authorization"), false)

      credential = {
        type: "oauth",
        methodID: METHOD_ID,
        access: "subscription-token",
        metadata: { [CLAUDE_CODE_OAUTH_METADATA_KEY]: "v1" },
      }
      event.request = nativeRequest()
      await hooks.get("http.request")!(event)
      assert.equal(
        event.request.headers.get("authorization"),
        "Bearer subscription-token",
      )
      assert.equal(event.request.headers.has("x-api-key"), false)
      const response = { ...event, response: new Response("ok") }
      await hooks.get("http.response")!(response)
      assert.equal(await response.response.text(), "ok")
    } finally {
      await dispose?.()
    }
  })
})
