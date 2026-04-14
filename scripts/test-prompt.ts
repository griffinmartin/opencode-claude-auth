import {
  getCachedCredentials,
  initAccounts,
  setActiveAccountSource,
} from "../dist/credentials.js"
import { buildRequestHeaders, fetchWithRetry } from "../dist/index.js"
import { readAllClaudeAccounts } from "../dist/keychain.js"
import { transformBody, transformResponseStream } from "../dist/transforms.js"
import { buildBillingHeaderValue } from "../dist/signing.js"
import { config } from "../dist/model-config.js"

const API_URL = "https://api.anthropic.com/v1/messages"
const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

const prompt = process.argv[2]
if (!prompt) {
  console.error("Usage: pnpm run test:prompt 'your prompt here' [model]")
  process.exit(1)
}

const modelId = process.argv[3] ?? "claude-sonnet-4-6"

// Init credentials
const accounts = readAllClaudeAccounts()
if (accounts.length === 0) {
  console.error("No Claude Code credentials found. Run `claude` to authenticate.")
  process.exit(1)
}
initAccounts(accounts)
setActiveAccountSource(accounts[0].source)

const creds = getCachedCredentials()
if (!creds) {
  console.error("Credentials expired. Run `claude` to refresh.")
  process.exit(1)
}

// Build messages
const messages = [{ role: "user", content: prompt }]

const version = process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
const billingHeader = buildBillingHeaderValue(messages, version, "cli")

const requestBody = {
  model: modelId,
  max_tokens: 4096,
  stream: true,
  system: [
    { type: "text", text: billingHeader },
    { type: "text", text: SYSTEM_IDENTITY },
  ],
  messages,
}

const body = transformBody(JSON.stringify(requestBody))

const init: RequestInit = { method: "POST", body }
const headers = buildRequestHeaders(
  new URL(API_URL),
  init,
  creds.accessToken,
  modelId,
)
headers.set("content-type", "application/json")

// Send request and stream response
const response = await fetchWithRetry(API_URL, { ...init, body, headers })

if (!response.ok) {
  const errorBody = await response.text()
  console.error(`API error ${response.status}:`, errorBody)
  process.exit(1)
}

const transformed = transformResponseStream(response)
const reader = transformed.body!.getReader()
const decoder = new TextDecoder()

let fullText = ""

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  const chunk = decoder.decode(value, { stream: true })
  // Parse SSE events
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6)
    if (data === "[DONE]") continue
    try {
      const event = JSON.parse(data) as {
        type?: string
        delta?: { type?: string; text?: string }
      }
      if (event.type === "content_block_delta" && event.delta?.text) {
        process.stdout.write(event.delta.text)
        fullText += event.delta.text
      }
    } catch {
      // skip non-JSON lines
    }
  }
}

if (fullText) console.log()
