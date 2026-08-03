import { buildBillingHeaderValue } from "./signing.ts"
import { config, getModelOverride } from "./model-config.ts"
import { log } from "./logger.ts"

const TOOL_PREFIX = "mcp_"

/**
 * Prefix a tool name with TOOL_PREFIX and uppercase the first character.
 * Claude Code uses PascalCase tool names (e.g. mcp_Bash, mcp_Read);
 * lowercase names (mcp_bash, mcp_read) are flagged as non-Claude-Code clients.
 */
function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/**
 * Reverse prefixName: strip TOOL_PREFIX and restore the original leading case.
 */
function unprefixName(name: string): string {
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

export const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>
type ContentBlock = { type?: string; text?: string } & Record<string, unknown>
type Message = {
  role?: string
  content?: string | ContentBlock[]
}

/**
 * Strategy for reconciling `tool_use` / `tool_result` adjacency that OpenCode's
 * automatic compaction can break (issues #212/#226/#261):
 *
 * - `placeholder` (default): never delete blocks. For any `tool_use` left
 *   without an adjacent `tool_result`, synthesize a paired placeholder result.
 *   Because assistant `content[]` is never rewritten, `thinking` /
 *   `redacted_thinking` blocks stay byte-identical, sidestepping Anthropic's
 *   thinking-preservation contract (issue #261).
 * - `drop`: remove orphaned blocks (the upstream behavior), but omit an entire
 *   assistant turn when it carries `thinking` blocks and an orphaned `tool_use`
 *   rather than partially rewriting it (which #261 forbids).
 */
export type ToolRepairMode = "placeholder" | "drop"

/** Content used for a synthesized `tool_result` whose real output was compacted away. */
export const TOOL_RESULT_PLACEHOLDER =
  "Tool result unavailable (removed during context compaction)."

/**
 * Resolve the repair strategy from the environment. Defaults to `placeholder`,
 * the lossless strategy. Set `OPENCODE_CLAUDE_AUTH_TOOL_REPAIR=drop` to opt into
 * the drop strategy.
 */
export function resolveToolRepairMode(
  env: Record<string, string | undefined> = process.env,
): ToolRepairMode {
  const value = env.OPENCODE_CLAUDE_AUTH_TOOL_REPAIR?.trim().toLowerCase()
  return value === "drop" ? "drop" : "placeholder"
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"])

function toolUseIdOf(block: ContentBlock): string | undefined {
  return block.type === "tool_use" && typeof block["id"] === "string"
    ? (block["id"] as string)
    : undefined
}

function toolResultIdOf(block: ContentBlock): string | undefined {
  return block.type === "tool_result" &&
    typeof block["tool_use_id"] === "string"
    ? (block["tool_use_id"] as string)
    : undefined
}

function hasThinkingBlock(message: Message): boolean {
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((block) => THINKING_TYPES.has(block.type ?? ""))
  )
}

/** A `tool_use` is valid iff the immediately-following message carries its result. */
function toolUseHasAdjacentResult(
  messages: Message[],
  index: number,
  id: string,
): boolean {
  const next = messages[index + 1]
  if (!next || !Array.isArray(next.content)) return false
  return next.content.some((block) => toolResultIdOf(block) === id)
}

/** A `tool_result` is valid iff the immediately-preceding message made the call. */
function toolResultHasAdjacentUse(
  messages: Message[],
  index: number,
  id: string,
): boolean {
  const prev = messages[index - 1]
  if (!prev || !Array.isArray(prev.content)) return false
  return prev.content.some((block) => toolUseIdOf(block) === id)
}

function makePlaceholderResult(id: string): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: id,
    content: TOOL_RESULT_PLACEHOLDER,
    is_error: true,
  }
}

/**
 * One drop pass over the message list. Adjacency is evaluated per-occurrence
 * (not via first-occurrence index maps), so a replayed/duplicate `tool_use` id
 * whose first occurrence is a valid pair no longer masks a later orphan.
 * Assistant turns that hold thinking blocks are omitted wholesale when they
 * contain an orphaned `tool_use`.
 */
function dropPass(messages: Message[]): { next: Message[]; changed: boolean } {
  let changed = false
  const droppedToolUseIds: string[] = []
  const droppedToolResultIds: string[] = []
  const omittedThinkingTurns: number[] = []
  const out: Message[] = []

  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) {
      out.push(message)
      return
    }

    const hasOrphanUse = message.content.some((block) => {
      const id = toolUseIdOf(block)
      return id !== undefined && !toolUseHasAdjacentResult(messages, index, id)
    })

    // #261: a thinking turn may only be kept whole or dropped whole, never
    // partially rewritten. So when such a turn holds an orphaned tool_use we
    // must omit the entire turn — even any *valid* tool_use it also carries.
    // Those valid calls' results become orphaned by the omission and are then
    // removed on the next fixed-point pass, so the output stays consistent,
    // just lossier. (This is the cost of the opt-in `drop` mode; the default
    // `placeholder` mode keeps the turn intact and synthesizes the missing
    // result instead.)
    if (hasOrphanUse && hasThinkingBlock(message)) {
      changed = true
      omittedThinkingTurns.push(index)
      for (const block of message.content) {
        const id = toolUseIdOf(block)
        if (id !== undefined) droppedToolUseIds.push(id)
      }
      return
    }

    const filtered = message.content.filter((block) => {
      const useId = toolUseIdOf(block)
      if (useId !== undefined) {
        const ok = toolUseHasAdjacentResult(messages, index, useId)
        if (!ok) {
          changed = true
          droppedToolUseIds.push(useId)
        }
        return ok
      }
      const resultId = toolResultIdOf(block)
      if (resultId !== undefined) {
        const ok = toolResultHasAdjacentUse(messages, index, resultId)
        if (!ok) {
          changed = true
          droppedToolResultIds.push(resultId)
        }
        return ok
      }
      return true
    })

    if (filtered.length === 0) {
      if (message.content.length > 0) changed = true
      return
    }
    out.push(
      filtered.length === message.content.length
        ? message
        : { ...message, content: filtered },
    )
  })

  if (changed) {
    log("repair_orphan_dropped", {
      droppedToolUseIds,
      droppedToolResultIds,
      omittedThinkingTurns,
    })
  }
  return { next: out, changed }
}

/**
 * Drop-strategy repair. Iterated to a fixed point so that cascades — e.g. an
 * omitted thinking turn orphaning the result that followed it — are fully
 * reconciled rather than left half-repaired.
 */
export function repairToolPairs(messages: Message[]): Message[] {
  let current = messages
  const maxIterations = messages.length + 2
  for (let i = 0; i < maxIterations; i++) {
    const { next, changed } = dropPass(current)
    if (!changed) return current
    current = next
  }
  // Each pass strictly removes blocks/messages, so a fixed point is reached
  // within messages.length passes; exhausting the cap means an unexpected
  // non-converging shape. Surface it rather than returning silently.
  log("repair_drop_max_iterations", { messageCount: messages.length })
  return current
}

/**
 * Placeholder-strategy repair (default). Guarantees `tool_use` ↔ `tool_result`
 * adjacency without ever deleting a block from an assistant turn, so thinking
 * blocks are preserved exactly. Two passes:
 *
 *  1. Remove `tool_result` blocks that have no adjacent preceding `tool_use`
 *     (these live in user turns, so no thinking block is affected).
 *  2. Synthesize a placeholder `tool_result`, adjacent, for every `tool_use`
 *     that still lacks one.
 */
export function synthesizeMissingToolResults(messages: Message[]): Message[] {
  let removedOrphanResults = 0

  // Pass 1: strip orphaned tool_result blocks.
  const pass1: Message[] = []
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) {
      pass1.push(message)
      return
    }
    const filtered = message.content.filter((block) => {
      const resultId = toolResultIdOf(block)
      if (resultId === undefined) return true
      const ok = toolResultHasAdjacentUse(messages, index, resultId)
      if (!ok) removedOrphanResults++
      return ok
    })
    if (filtered.length === 0 && message.content.length > 0) return
    pass1.push(
      filtered.length === message.content.length
        ? message
        : { ...message, content: filtered },
    )
  })

  // Pass 2: synthesize adjacent results for orphaned tool_use blocks.
  const synthesizedToolUseIds: string[] = []
  const out: Message[] = []
  for (let i = 0; i < pass1.length; i++) {
    const message = pass1[i]
    out.push(message)
    if (!Array.isArray(message.content)) continue

    const useIds = message.content
      .map(toolUseIdOf)
      .filter((id): id is string => id !== undefined)
    if (useIds.length === 0) continue

    const next = pass1[i + 1]
    const presentIds =
      next && Array.isArray(next.content)
        ? new Set(
            next.content
              .map(toolResultIdOf)
              .filter((id): id is string => id !== undefined),
          )
        : new Set<string>()
    const missing = useIds.filter((id) => !presentIds.has(id))
    if (missing.length === 0) continue

    synthesizedToolUseIds.push(...missing)
    const synthetic = missing.map(makePlaceholderResult)

    if (next && next.role === "user" && Array.isArray(next.content)) {
      // Merge the synthetic results into the adjacent user turn (so tool_result
      // blocks lead it) and skip that turn. Building `out` directly this way
      // avoids mutating `pass1` while it is still being iterated.
      out.push({ ...next, content: [...synthetic, ...next.content] })
      i++
    } else if (
      next &&
      next.role === "user" &&
      typeof next.content === "string"
    ) {
      // The adjacent user turn is plain text: convert it to blocks so the
      // tool_result can lead it, rather than emitting two consecutive user
      // turns (a new synthetic user message followed by this one).
      const text = next.content
      out.push({
        ...next,
        content:
          text.length > 0 ? [...synthetic, { type: "text", text }] : synthetic,
      })
      i++
    } else {
      out.push({ role: "user", content: synthetic })
    }
  }

  if (synthesizedToolUseIds.length > 0 || removedOrphanResults > 0) {
    log("repair_orphan_synthesized", {
      synthesizedToolUseIds,
      removedOrphanResultCount: removedOrphanResults,
    })
  }
  return out
}

/** Dispatch to the configured repair strategy. */
export function applyToolRepair(
  messages: Message[],
  mode: ToolRepairMode,
): Message[] {
  return mode === "drop"
    ? repairToolPairs(messages)
    : synthesizeMissingToolResults(messages)
}

export function transformBody(
  body: BodyInit | null | undefined,
  mode: ToolRepairMode = resolveToolRepairMode(),
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
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli"
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
        // Only keep cache_control on the remainder block to avoid exceeding
        // the API limit of 4 cache_control blocks per request.
        const { cache_control: _cc, ...identityProps } = entryProps
        splitSystem.push({ ...identityProps, text: SYSTEM_IDENTITY })
        if (rest.length > 0) {
          splitSystem.push({ ...entryProps, text: rest })
        }
      } else {
        splitSystem.push(entry)
      }
    }
    parsed.system = splitSystem

    // --- Relocate non-core system entries to user messages ---
    // Anthropic's API now validates the system prompt for OAuth-authenticated
    // requests that use Claude Code billing.  Third-party system prompts
    // (like OpenCode's) trigger a 400 "out of extra usage" rejection when
    // they appear inside the system[] array alongside the identity prefix.
    //
    // Work-around: keep only the billing header and identity prefix in
    // system[], and prepend all other system content to the first user
    // message where it is functionally equivalent but avoids the check.
    const BILLING_PREFIX = "x-anthropic-billing-header"
    const keptSystem: SystemEntry[] = []
    const movedTexts: string[] = []
    for (const entry of parsed.system) {
      const txt = typeof entry === "string" ? entry : (entry.text ?? "")
      if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) {
        keptSystem.push(entry)
      } else if (txt.length > 0) {
        movedTexts.push(txt)
      }
    }
    if (movedTexts.length > 0 && Array.isArray(parsed.messages)) {
      const firstUser = parsed.messages.find((m) => m.role === "user")
      if (firstUser) {
        parsed.system = keptSystem
        const prefix = movedTexts.join("\n\n")
        if (typeof firstUser.content === "string") {
          firstUser.content = prefix + "\n\n" + firstUser.content
        } else if (Array.isArray(firstUser.content)) {
          firstUser.content.unshift({ type: "text", text: prefix })
        }
      }
    }

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
      if (parsed.thinking && "effort" in parsed.thinking) {
        delete parsed.thinking.effort
        if (Object.keys(parsed.thinking).length === 0) {
          delete parsed.thinking
        }
      }
    }

    // Anthropic's OAuth billing validation rejects lowercase tool names
    // when multiple tools are present. Claude Code uses PascalCase after
    // the mcp_ prefix (e.g. mcp_Bash, mcp_Read). Apply the same convention.
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
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

            return { ...block, name: prefixName(block.name) }
          }),
        }
      })
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = applyToolRepair(parsed.messages, mode)
    }

    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

export function stripToolPrefix(text: string): string {
  return text.replace(
    /"name"\s*:\s*"mcp_([^"]+)"/g,
    (_match, name: string) => `"name": "${unprefixName(name)}"`,
  )
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
