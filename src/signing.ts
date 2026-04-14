import { createHash } from "node:crypto"

const BILLING_SALT = "59cf53e54c78"

interface Message {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

/**
 * Extract text from the first user message's first text block.
 * Matches Claude Code's K19() function exactly: find the first message
 * with role "user", then return the text of its first text content block.
 */
export function extractFirstUserMessageText(messages: Message[]): string {
  const userMsg = messages.find((m) => m.role === "user")
  if (!userMsg) return ""
  const content = userMsg.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text")
    if (textBlock && textBlock.type === "text" && textBlock.text) {
      return textBlock.text
    }
  }
  return ""
}

/**
 * Compute the 3-char version suffix.
 * Samples characters at indices 4, 7, 20 from the message text (padding
 * with "0" when the message is shorter), then hashes with the billing salt
 * and version string.
 */
export function computeVersionSuffix(
  messageText: string,
  version: string,
): string {
  const sampled = [4, 7, 20]
    .map((i) => (i < messageText.length ? messageText[i] : "0"))
    .join("")
  const input = `${BILLING_SALT}${sampled}${version}`
  return createHash("sha256").update(input).digest("hex").slice(0, 3)
}

/**
 * Build the billing header string with cch=00000 placeholder.
 * Format matches Claude Code exactly:
 *   x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=00000;
 *
 * The placeholder is later replaced with the real xxHash64-based cch
 * by computeCchHash() after the full body is serialized.
 */
export function buildBillingHeaderValue(
  messages: Message[],
  version: string,
  entrypoint: string,
): string {
  const text = extractFirstUserMessageText(messages)
  const suffix = computeVersionSuffix(text, version)
  return (
    `x-anthropic-billing-header: ` +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    `cch=00000;`
  )
}
