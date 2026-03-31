/**
 * Validate that the direct OAuth token refresh works against the real endpoint.
 *
 * Reads your current Claude Code credentials, attempts a token refresh via
 * POST https://claude.ai/v1/oauth/token, and reports the results.
 *
 * Usage:
 *   pnpm run build && node --experimental-strip-types scripts/validate-oauth-refresh.ts
 *
 * Options:
 *   --dry-run    Show what would be sent without making the request
 *   --write-back Test the write-back logic (updates Keychain/credentials file)
 */

import {
  readAllClaudeAccounts,
  writeBackCredentials,
} from "../dist/keychain.js"

const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

const args = new Set(process.argv.slice(2))
const dryRun = args.has("--dry-run")
const testWriteBack = args.has("--write-back")

function redact(token: string, visibleChars = 8): string {
  if (token.length <= visibleChars) return "***"
  return `${token.slice(0, visibleChars)}...[${token.length} chars]`
}

function formatExpiry(expiresAt: number): string {
  const now = Date.now()
  const remaining = expiresAt - now
  const date = new Date(expiresAt).toISOString()
  if (remaining <= 0)
    return `${date} (EXPIRED ${Math.round(-remaining / 1000)}s ago)`
  const hours = Math.floor(remaining / 3_600_000)
  const mins = Math.floor((remaining % 3_600_000) / 60_000)
  return `${date} (${hours}h ${mins}m remaining)`
}

async function main() {
  console.log("=== OAuth Refresh Validation ===\n")

  // Step 1: Read credentials
  console.log("1. Reading credentials...")
  let accounts
  try {
    accounts = readAllClaudeAccounts()
  } catch (err) {
    console.error(
      "   FAIL: Could not read credentials:",
      (err as Error).message,
    )
    process.exit(1)
  }

  if (accounts.length === 0) {
    console.error("   FAIL: No Claude Code credentials found.")
    console.error("   Run `claude` to authenticate first.")
    process.exit(1)
  }

  console.log(`   Found ${accounts.length} account(s):`)
  for (const acc of accounts) {
    console.log(`   - ${acc.label} (${acc.source})`)
    console.log(`     Access token:  ${redact(acc.credentials.accessToken)}`)
    console.log(`     Refresh token: ${redact(acc.credentials.refreshToken)}`)
    console.log(
      `     Expires:       ${formatExpiry(acc.credentials.expiresAt)}`,
    )
  }

  const account = accounts[0]
  console.log(`\n   Using: ${account.label} (${account.source})`)

  // Step 2: Prepare the request
  const refreshToken = account.credentials.refreshToken
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  })

  console.log("\n2. OAuth refresh request:")
  console.log(`   POST ${OAUTH_TOKEN_URL}`)
  console.log(`   client_id:     ${OAUTH_CLIENT_ID}`)
  console.log(`   refresh_token: ${redact(refreshToken)}`)

  if (dryRun) {
    console.log("\n   --dry-run: Skipping actual request.")
    process.exit(0)
  }

  // Step 3: Make the request
  console.log("\n3. Sending request...")
  const startTime = Date.now()

  let response: Response
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
  } catch (err) {
    console.error("   FAIL: Network error:", (err as Error).message)
    process.exit(1)
  }

  const elapsed = Date.now() - startTime
  console.log(
    `   Status: ${response.status} ${response.statusText} (${elapsed}ms)`,
  )

  if (!response.ok) {
    const text = await response.text()
    console.error("   FAIL: OAuth endpoint returned error:")
    console.error(`   ${text}`)
    process.exit(1)
  }

  // Step 4: Parse the response
  const data = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    token_type?: string
    scope?: string
  }

  console.log("\n4. Response:")
  console.log(`   token_type:    ${data.token_type ?? "(not provided)"}`)
  console.log(
    `   access_token:  ${data.access_token ? redact(data.access_token) : "MISSING"}`,
  )
  console.log(
    `   refresh_token: ${data.refresh_token ? redact(data.refresh_token) : "(not rotated)"}`,
  )
  console.log(`   expires_in:    ${data.expires_in ?? "(not provided)"}s`)
  if (data.scope) {
    console.log(`   scope:         ${data.scope}`)
  }

  if (!data.access_token) {
    console.error("\n   FAIL: No access_token in response.")
    process.exit(1)
  }

  const newExpiresAt = Date.now() + (data.expires_in ?? 36_000) * 1000
  console.log(`   New expiry:    ${formatExpiry(newExpiresAt)}`)

  // Step 5: Compare tokens
  console.log("\n5. Token comparison:")
  const sameAccess = data.access_token === account.credentials.accessToken
  const sameRefresh = data.refresh_token === refreshToken || !data.refresh_token
  console.log(
    `   Access token changed:  ${sameAccess ? "NO (same token returned)" : "YES"}`,
  )
  console.log(
    `   Refresh token rotated: ${sameRefresh ? "NO" : "YES (new refresh token issued)"}`,
  )

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.log("\n   WARNING: Refresh token was rotated.")
    console.log("   The old token in Keychain may now be invalid.")
    console.log("   This confirms write-back is necessary for production use.")
  }

  // Step 6: Optionally test write-back
  if (testWriteBack) {
    console.log("\n6. Testing write-back...")
    const newCreds = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: newExpiresAt,
    }
    const success = writeBackCredentials(account.source, newCreds)
    if (success) {
      console.log("   OK: Credentials written back to storage.")
    } else {
      console.error("   FAIL: Write-back returned false.")
      process.exit(1)
    }

    // Verify by re-reading
    const reread = readAllClaudeAccounts()
    const updated = reread.find((a) => a.source === account.source)
    if (updated && updated.credentials.accessToken === data.access_token) {
      console.log("   OK: Re-read confirms new credentials in storage.")
    } else {
      console.error("   FAIL: Re-read did not return updated credentials.")
      process.exit(1)
    }
  }

  console.log("\n=== PASS: OAuth refresh works correctly ===")
}

main().catch((err) => {
  console.error("Unexpected error:", err)
  process.exit(1)
})
