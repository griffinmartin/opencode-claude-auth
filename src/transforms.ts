import { buildBillingHeaderValue } from "./signing.ts"
import { config, getModelOverride } from "./model-config.ts"

const TOOL_PREFIX = "mcp_"

const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>

export function transformBody(
  body: BodyInit | null | undefined,
): BodyInit | null | undefined {
  if (typeof body !== "string") {
    return body
  }

  try {
    const parsed = JSON.parse(body) as {
      model?: string
      system?: SystemEntry[]
      thinking?: Record<string, unknown>
      // eslint-disable-next-line @typescript-eslint/naming-convention
      output_config?: Record<string, unknown>
      tools?: Array<{ name?: string } & Record<string, unknown>>
      messages?: Array<{
        role?: string
        content?:
          | string
          | Array<{ type?: string; text?: string } & Record<string, unknown>>
      }>
    }

    // --- Billing header: inject as system[0] (no cache_control) ---
    const version = process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli"
    const billingHeader = buildBillingHeaderValue(
      (parsed.messages ?? []) as Array<{
        role?: string
        content?: string | Array<{ type?: string; text?: string }>
      }>,
      version,
      entrypoint,
    )

    if (!Array.isArray(parsed.system)) {
      parsed.system = []
    }

    // Remove any existing billing header entries
    parsed.system = parsed.system.filter(
      (e) =>
        !(
          e.type === "text" &&
          typeof e.text === "string" &&
          e.text.startsWith("x-anthropic-billing-header")
        ),
    )

    // Insert billing header as system[0], without cache_control
    parsed.system.unshift({ type: "text", text: billingHeader })

    // --- Split identity prefix into its own system entry ---
    // OpenCode's system.transform hook prepends the identity string, but
    // OpenCode then concatenates all system entries into a single text block.
    // Anthropic's API requires the identity string as a separate entry for
    // OAuth validation (see issue #98).
    const splitSystem: SystemEntry[] = []
    for (const entry of parsed.system) {
      if (
        entry.type === "text" &&
        typeof entry.text === "string" &&
        entry.text.startsWith(SYSTEM_IDENTITY) &&
        entry.text.length > SYSTEM_IDENTITY.length
      ) {
        const rest = entry.text
          .slice(SYSTEM_IDENTITY.length)
          .replace(/^\n+/, "")
        // Preserve all properties except text (e.g. cache_control)
        const { text: _text, ...entryProps } = entry
        splitSystem.push({ ...entryProps, text: SYSTEM_IDENTITY })
        if (rest.length > 0) {
          splitSystem.push({ ...entryProps, text: rest })
        }
      } else {
        splitSystem.push(entry)
      }
    }
    parsed.system = splitSystem

    // Strip effort for models that don't support it (e.g. haiku).
    // OpenCode sends { output_config: { effort: "high" } } but haiku
    // rejects the effort parameter with a 400 error.
    const modelId = parsed.model ?? ""
    const override = getModelOverride(modelId)
    if (override?.disableEffort) {
      if (parsed.output_config) {
        delete parsed.output_config.effort
        if (Object.keys(parsed.output_config).length === 0) {
          delete parsed.output_config
        }
      }
      if (parsed.thinking) {
        delete parsed.thinking.effort
        if (!("budget_tokens" in parsed.thinking)) {
          delete parsed.thinking
        }
      }
    }

    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }))
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (!Array.isArray(message.content)) {
          return message
        }

        return {
          ...message,
          content: message.content.map((block) => {
            if (block.type !== "tool_use" || typeof block.name !== "string") {
              return block
            }

            return {
              ...block,
              name: `${TOOL_PREFIX}${block.name}`,
            }
          }),
        }
      })
    }

    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

export function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
}

export function transformResponseStream(response: Response): Response {
  if (!response.body) {
    return response
  }

  // Don't wrap error responses through the SSE parser — pass them through
  // with only tool-prefix stripping on the raw body. This preserves error
  // messages for OpenCode / AI SDK to handle properly.
  if (!response.ok) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    const passthrough = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        const text = decoder.decode(value, { stream: true })
        controller.enqueue(encoder.encode(stripToolPrefix(text)))
      },
    })

    return new Response(passthrough, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  const stream = new ReadableStream({
    async pull(controller) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary !== -1) {
          const completeEvent = buffer.slice(0, boundary + 2)
          buffer = buffer.slice(boundary + 2)
          controller.enqueue(encoder.encode(stripToolPrefix(completeEvent)))
          return
        }

        const { done, value } = await reader.read()

        if (done) {
          if (buffer) {
            controller.enqueue(encoder.encode(stripToolPrefix(buffer)))
            buffer = ""
          }
          controller.close()
          return
        }

        buffer += decoder.decode(value, { stream: true })
      }
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
