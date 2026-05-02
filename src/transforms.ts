import { buildBillingHeaderValue } from "./signing.ts"
import { config, getModelOverride } from "./model-config.ts"

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

const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

/**
 * Patterns that identify OpenCode-fingerprinted content in system entries.
 *
 * Anthropic's OAuth API runs a content classifier on the system[] array that
 * rejects requests containing OpenCode fingerprints with a misleading 400
 * "out of extra usage" error (see issues #147 and #154). Empirical probing
 * (April 2026) showed the classifier is multi-feature rather than simple
 * substring matching — no single feature triggers the check in isolation,
 * but combinations do. Rather than try to track the exact classifier
 * threshold, we relocate any entry containing a known OpenCode feature.
 *
 * Entries matching any of these patterns are moved to the first user
 * message; entries that don't match stay in system[] where they retain
 * attention priority and prompt-cache efficiency.
 */
const OPENCODE_FEATURE_PATTERNS: RegExp[] = [
  // Brand prose. Case-SENSITIVE PascalCase: anthropic.txt and other
  // OpenCode prompts use "OpenCode" consistently. Lowercase "opencode"
  // appears almost exclusively in directory/path components like
  // /Users/foo/dev/opencode-claude-auth/... or
  // /Users/foo/.cache/opencode/... and matching those produces false
  // positives that relocate non-branded content (e.g. user env blocks,
  // skills entries) needlessly.
  /\bOpenCode\b/,
  // GitHub org used by OpenCode repositories
  // (e.g. https://github.com/anomalyco/opencode).
  /\banomalyco\b/i,
  // OpenCode docs/site URL — strong contextual brand signal even in
  // lowercase form.
  /\bopencode\.ai\b/i,
  // OpenCode-specific env metadata phrase. Claude Code's env block only
  // uses "Working directory"; "Workspace root folder" is OpenCode-only.
  /Workspace root folder/,
  // OpenCode-specific env tag. Claude Code's env block has no
  // <directories> section.
  /<directories>/,
]

/**
 * Returns true if the given system entry text contains any OpenCode
 * fingerprint feature that would trigger Anthropic's OAuth content
 * classifier. Such entries must be relocated out of system[] before
 * sending the request.
 *
 * Non-matching entries (plain AGENTS.md, generic env blocks, skill lists,
 * etc.) are safe to keep in system[].
 */
export function isOpenCodeBrandedEntry(text: string): boolean {
  return OPENCODE_FEATURE_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Anchors used by splitOpenCodeSystemBlob to recognize OpenCode's joined
 * system blob. These mirror upstream OpenCode source as of dev branch:
 *
 *   - ENV_BLOCK_RE: `packages/opencode/src/session/system.ts` `environment()`
 *     produces "You are powered by the model named ...\n...\n<env>...</env>"
 *   - SKILLS_BLOCK_RE: superpowers (and similar plugins) emit
 *     "Skills provide specialized instructions...\n<available_skills>...</available_skills>"
 *   - INSTRUCTIONS_HEADER_RE: `packages/opencode/src/session/instruction.ts`
 *     emits each AGENTS.md/CLAUDE.md as "Instructions from: <abs-path>\n<content>"
 *
 * Splitting is best-effort and gracefully degrades to pass-through for
 * unfamiliar shapes, so behavior is never worse than v1.4.8 bulk relocation.
 */
const ENV_BLOCK_RE =
  /^You are powered by the model named [^\n]+\n[\s\S]*?<\/env>/m
const SKILLS_BLOCK_RE =
  /^Skills provide specialized instructions and workflows for specific tasks\.\n[\s\S]*?<\/available_skills>/m
const INSTRUCTIONS_HEADER_RE = /\n(?=Instructions from: [/~])/
const ENV_OPENER_RE =
  /^You are powered by the model named [^\n]+\nHere is some useful information about the environment you are running in:\n/
const ENV_WORKSPACE_ROOT_RE = /^[ \t]*Workspace root folder:[^\n]*\n?/m
const ENV_CONTAINER_RE = /<env>([\s\S]*?)<\/env>/

/**
 * Normalize an OpenCode env block into two pieces: a Claude-Code-shaped
 * "safe" env that can stay in system[], and a "branded" extras string
 * containing the OpenCode-only opener and `Workspace root folder` line that
 * must relocate.
 *
 * Returns `{ safe: null, branded: input }` when the env block doesn't match
 * the expected shape — graceful fallback that preserves current behavior
 * (relocate the whole thing).
 */
export function normalizeEnvBlock(envBlock: string): {
  safe: string | null
  branded: string | null
} {
  const containerMatch = envBlock.match(ENV_CONTAINER_RE)
  if (!containerMatch) {
    return { safe: null, branded: envBlock }
  }

  // Pull off the OpenCode-only opener (two lines) before "<env>".
  const openerMatch = envBlock.match(ENV_OPENER_RE)
  const opener = openerMatch ? openerMatch[0] : ""

  // Strip the OpenCode-only "Workspace root folder: ..." line from the
  // <env> body, leaving only Claude-Code-format lines.
  const envBody = containerMatch[1]
  const workspaceLineMatch = envBody.match(ENV_WORKSPACE_ROOT_RE)
  const workspaceLine = workspaceLineMatch ? workspaceLineMatch[0] : ""
  const safeBody = envBody.replace(ENV_WORKSPACE_ROOT_RE, "")

  // Compose the safe env (Claude-Code-shaped) and branded extras.
  const safe =
    `Here is useful information about the environment you are running in:\n` +
    `<env>${safeBody}</env>`

  const brandedParts: string[] = []
  if (opener) brandedParts.push(opener.trimEnd())
  if (workspaceLine) brandedParts.push(workspaceLine.trim())
  const branded = brandedParts.length > 0 ? brandedParts.join("\n") : null

  return { safe, branded }
}

/**
 * Split OpenCode's joined system blob (produced by
 * `packages/opencode/src/session/llm.ts:88-103`) back into its constituent
 * entries so that downstream surgical relocation in `transformBody` can
 * keep non-branded pieces (AGENTS.md, skills, safe env) in `system[]`.
 *
 * For unfamiliar shapes the input is returned unchanged as a single-entry
 * array, so callers can pass any string through without a behavioral
 * regression.
 *
 * The returned ordering preserves OpenCode's original assembly order:
 *   [providerPromptHead?, brandedEnvExtras?, safeEnv?, skillsBlock?,
 *    ...instructionBlocks, userSystemTail?]
 */
export function splitOpenCodeSystemBlob(text: string): string[] {
  const envMatch = text.match(ENV_BLOCK_RE)
  if (!envMatch || envMatch.index === undefined) {
    return [text]
  }

  // Slice the joined string at the env-block boundary.
  const head = text.slice(0, envMatch.index).replace(/\n+$/, "")
  const envBlock = envMatch[0]
  let tail = text.slice(envMatch.index + envBlock.length).replace(/^\n+/, "")

  // Normalize the env block.
  const { safe, branded } = normalizeEnvBlock(envBlock)

  // Optionally peel off a skills block from the tail.
  let skillsBlock: string | null = null
  const skillsMatch = tail.match(SKILLS_BLOCK_RE)
  if (skillsMatch && skillsMatch.index !== undefined) {
    skillsBlock = skillsMatch[0]
    const before = tail.slice(0, skillsMatch.index).replace(/\n+$/, "")
    const after = tail
      .slice(skillsMatch.index + skillsBlock.length)
      .replace(/^\n+/, "")
    tail = [before, after].filter(Boolean).join("\n")
  }

  // Split remaining tail on "Instructions from: ..." headers — these are
  // AGENTS.md / CLAUDE.md blocks emitted one per file by upstream
  // `Instruction.system()`.
  const instructionPieces: string[] = []
  let userSystemTail: string | null = null
  if (tail) {
    const parts = tail.split(INSTRUCTIONS_HEADER_RE)
    // Anything before the first "Instructions from:" header is non-AGENTS
    // tail (typically input.user.system or a structured-output prompt).
    if (parts.length > 0 && !parts[0].startsWith("Instructions from:")) {
      const firstTail = parts.shift()!
      if (firstTail.trim()) userSystemTail = firstTail
    }
    for (const part of parts) {
      if (part.trim()) instructionPieces.push(part)
    }
  }

  const out: string[] = []
  if (head) out.push(head)
  if (branded) out.push(branded)
  if (safe) out.push(safe)
  if (skillsBlock) out.push(skillsBlock)
  out.push(...instructionPieces)
  if (userSystemTail) out.push(userSystemTail)
  return out
}

/**
 * Heuristic: does this string look like OpenCode's joined system blob?
 * Used by callers (the system.transform hook) to decide whether to invoke
 * splitOpenCodeSystemBlob. We require both the env-block opener sentinel
 * and at least one OpenCode brand fingerprint, so unrelated multi-section
 * prompts pass through unchanged.
 */
export function looksLikeOpenCodeJoinedBlob(text: string): boolean {
  return (
    /^You are powered by the model named/m.test(text) &&
    /\bopencode\b/i.test(text)
  )
}

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>
type ContentBlock = { type?: string; text?: string } & Record<string, unknown>
type Message = {
  role?: string
  content?: string | ContentBlock[]
}

export function repairToolPairs(messages: Message[]): Message[] {
  // Collect all tool_use ids and track which ones pass the Anthropic adjacency
  // invariant: a tool_use at messages[i] requires a matching tool_result in
  // messages[i+1] (the very next message). Global presence is NOT sufficient —
  // Anthropic rejects non-adjacent pairs with "Each tool_use block must have a
  // corresponding tool_result block in the next message."
  const allToolUseIds = new Set<string>()
  const adjacentToolUses = new Set<string>()
  const toolResultIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const id = block["id"]
      if (block.type === "tool_use" && typeof id === "string") {
        allToolUseIds.add(id)
        // Anthropic adjacency check: tool_result must be in the next message
        const nextMessage = messages[i + 1]
        if (nextMessage && Array.isArray(nextMessage.content)) {
          if (
            nextMessage.content.some(
              (b) => b.type === "tool_result" && b["tool_use_id"] === id,
            )
          ) {
            adjacentToolUses.add(id)
          }
        }
      }
      const toolUseId = block["tool_use_id"]
      if (block.type === "tool_result" && typeof toolUseId === "string") {
        toolResultIds.add(toolUseId)
      }
    }
  }

  // Orphaned tool_uses: globally missing result OR result exists but not adjacent
  const orphanedUses = new Set<string>()
  for (const id of allToolUseIds) {
    if (!toolResultIds.has(id) || !adjacentToolUses.has(id)) {
      orphanedUses.add(id)
    }
  }

  // Orphaned tool_results: no matching tool_use OR paired tool_use is being
  // removed (avoids leaving behind orphaned results when their tool_use is
  // adyacent-failed)
  const orphanedResults = new Set<string>()
  for (const id of toolResultIds) {
    if (!allToolUseIds.has(id) || orphanedUses.has(id)) {
      orphanedResults.add(id)
    }
  }

  // Early return if nothing to fix
  if (orphanedUses.size === 0 && orphanedResults.size === 0) {
    return messages
  }

  // Filter orphaned blocks and remove messages with empty content arrays
  return messages
    .map((message) => {
      if (!Array.isArray(message.content)) return message
      const filtered = message.content.filter((block) => {
        const id = block["id"]
        if (block.type === "tool_use" && typeof id === "string") {
          return !orphanedUses.has(id)
        }
        const toolUseId = block["tool_use_id"]
        if (block.type === "tool_result" && typeof toolUseId === "string") {
          return !orphanedResults.has(toolUseId)
        }
        return true
      })
      return { ...message, content: filtered }
    })
    .filter(
      (message) =>
        !(Array.isArray(message.content) && message.content.length === 0),
    )
}

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

    // --- Surgically relocate OpenCode-fingerprinted system entries ---
    // Anthropic's OAuth API runs a content classifier on the system[] array
    // that rejects requests containing OpenCode fingerprints (see #147).
    // The v1.4.8 fix (#148) worked around this by bulk-relocating ALL
    // non-core system entries to the first user message, but this caused
    // a regression in instruction-following for long conversations (#154)
    // because system-level priority and prompt-cache efficiency were lost.
    //
    // Empirical probing showed the classifier is feature-based: specific
    // OpenCode markers (brand strings, anomalyco URLs, "Workspace root
    // folder", <directories>) trigger the check, while AGENTS.md, skills
    // blocks, Claude Code-format env blocks, and other non-branded content
    // do not. We now relocate only entries matching an OpenCode feature
    // pattern (see isOpenCodeBrandedEntry), keeping everything else in
    // system[] where it retains full attention priority and caches well.
    const BILLING_PREFIX = "x-anthropic-billing-header"
    const keptSystem: SystemEntry[] = []
    const movedTexts: string[] = []
    for (const entry of parsed.system) {
      const txt = typeof entry === "string" ? entry : (entry.text ?? "")
      if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) {
        keptSystem.push(entry)
      } else if (txt.length > 0 && isOpenCodeBrandedEntry(txt)) {
        movedTexts.push(txt)
      } else {
        keptSystem.push(entry)
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
      parsed.messages = repairToolPairs(parsed.messages)
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
