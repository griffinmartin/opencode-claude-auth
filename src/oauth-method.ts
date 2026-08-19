import { Credential, Integration } from "@opencode-ai/plugin"
import {
  getCachedCredentials,
  loadPersistedAccountSource,
  refreshAccountsList,
  refreshViaOAuth,
  reloadCredentialsFromSource,
  saveAccountSource,
  setActiveAccountSource,
} from "./credentials.ts"
import {
  writeBackCredentials,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./keychain.ts"
import { log } from "./logger.ts"

export const INTEGRATION_ID: Integration.ID = Integration.ID.make("anthropic")
export const METHOD_ID: Integration.MethodID =
  Integration.MethodID.make("claude-code")

/**
 * Everything this module needs from credentials.ts/keychain.ts/logger.ts,
 * injected rather than imported directly. Keeps this file framework-agnostic
 * (no Effect, no Promise-specific wrapping) and trivially testable with plain
 * fakes - both the Effect-based and Promise-based plugin entrypoints wire in
 * the same real implementations at the top level.
 */
export interface OAuthDeps {
  refreshAccountsList: () => ClaudeAccount[]
  loadPersistedAccountSource: () => string | null
  getCachedCredentials: () => Promise<ClaudeCredentials | null>
  setActiveAccountSource: (source: string) => void
  saveAccountSource: (source: string) => void
  reloadCredentialsFromSource: () => ClaudeCredentials | null
  refreshViaOAuth: (refreshToken: string) => Promise<ClaudeCredentials | null>
  writeBackCredentials: (
    source: string,
    creds: ClaudeCredentials,
    configDir: string | undefined,
    expectedPriorAccessToken: string,
  ) => boolean
  log: (event: string, data?: Record<string, unknown>) => void
}

export interface AuthorizeInputs {
  readonly account?: unknown
}

export interface OAuthMethodDescriptor {
  readonly id: Integration.MethodID
  readonly type: "oauth"
  readonly label: string
  // NOTE: `prompts`/`type: "select"` predates the current Form.Fields schema
  // (form?: Form.Fields, whose field union has no "select" variant). This
  // has been silently non-functional against recent OpenCode builds - it
  // only ever "type-checked" because TS skips excess-property checks on
  // indirectly-constructed values. Preserved as-is here (pre-existing,
  // unrelated to the effect/Promise migration) rather than silently
  // redesigned; needs a real fix using Form.Fields before multi-account
  // selection actually works again.
  readonly prompts?: ReadonlyArray<{
    readonly type: "select"
    readonly key: string
    readonly message: string
    readonly options: ReadonlyArray<{
      readonly label: string
      readonly value: string
      readonly hint: string
    }>
  }>
}

export function oauthMethodDescriptor(
  accounts: readonly ClaudeAccount[],
): OAuthMethodDescriptor {
  return {
    id: METHOD_ID,
    type: "oauth" as const,
    label: "Import Claude Code subscription",
    ...(accounts.length <= 1
      ? {}
      : {
          prompts: [
            {
              type: "select" as const,
              key: "account",
              message: "Select a Claude Code account",
              options: accounts.map((account) => ({
                label: account.label,
                value: account.source,
                hint: account.source,
              })),
            },
          ],
        }),
  }
}

export function resolveAuthorizeSource(
  inputs: AuthorizeInputs,
  fallbackAccounts: readonly ClaudeAccount[],
  deps: Pick<OAuthDeps, "refreshAccountsList" | "loadPersistedAccountSource">,
): string | undefined {
  const latest = deps.refreshAccountsList()
  return (
    (typeof inputs.account === "string" ? inputs.account : undefined) ??
    deps.loadPersistedAccountSource() ??
    latest[0]?.source ??
    fallbackAccounts[0]?.source
  )
}

export async function buildOAuthCredential(
  source: string,
  deps: OAuthDeps,
): Promise<Credential.OAuth> {
  const accounts = deps.refreshAccountsList()
  const account = accounts.find((item) => item.source === source) ?? accounts[0]
  if (!account)
    throw new Error(
      "No Claude Code credentials found. Run `claude` to authenticate first.",
    )
  deps.setActiveAccountSource(account.source)
  deps.saveAccountSource(account.source)
  const value = (await deps.getCachedCredentials()) ?? account.credentials
  return Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    access: value.accessToken,
    refresh: value.refreshToken,
    expires: value.expiresAt,
    metadata: {
      source: account.source,
      label: account.label,
      ...(account.configDir ? { configDir: account.configDir } : {}),
      ...(value.subscriptionType
        ? { subscriptionType: value.subscriptionType }
        : {}),
    },
  })
}

export async function authorizeOAuth(
  inputs: AuthorizeInputs,
  fallbackAccounts: readonly ClaudeAccount[],
  deps: OAuthDeps,
): Promise<Credential.OAuth> {
  const source = resolveAuthorizeSource(inputs, fallbackAccounts, deps)
  if (!source)
    throw new Error(
      "No Claude Code credentials found. Run `claude` to authenticate first.",
    )
  return buildOAuthCredential(source, deps)
}

export interface RefreshableCredential {
  readonly type: "oauth"
  readonly access: string
  readonly refresh: string
  readonly metadata?: Record<string, unknown>
}

export async function refreshOAuthCredential(
  value: RefreshableCredential,
  deps: OAuthDeps,
): Promise<Credential.OAuth> {
  const source =
    typeof value.metadata?.source === "string"
      ? value.metadata.source
      : undefined
  const configDir =
    typeof value.metadata?.configDir === "string"
      ? value.metadata.configDir
      : undefined

  // OpenCode persists whatever this returns and replays that same value on
  // every future refresh, forever, until we return something different. If
  // `claude` has since rotated credentials independently of this connection
  // (a fresh interactive login, its own periodic refresh, ...), the stored
  // refresh token goes permanently stale and every refresh fails with
  // invalid_grant even though a working credential is sitting in the
  // keychain right now. The keychain is the real source of truth, so check
  // it before ever attempting a network refresh with a token that may
  // already be dead.
  if (source) deps.setActiveAccountSource(source)
  const fresh = deps.reloadCredentialsFromSource()
  if (fresh && fresh.refreshToken !== value.refresh) {
    deps.log("refresh_resynced_from_keychain", { source })
    return Credential.OAuth.make({
      ...value,
      methodID: METHOD_ID,
      access: fresh.accessToken,
      refresh: fresh.refreshToken,
      expires: fresh.expiresAt,
    })
  }

  const refreshed = await deps.refreshViaOAuth(value.refresh)
  if (!refreshed)
    throw new Error(
      "Claude OAuth refresh failed. Run `claude` to re-authenticate.",
    )
  if (source)
    deps.writeBackCredentials(source, refreshed, configDir, value.access)
  return Credential.OAuth.make({
    ...value,
    methodID: METHOD_ID,
    access: refreshed.accessToken,
    refresh: refreshed.refreshToken,
    expires: refreshed.expiresAt,
  })
}

export function labelOAuthCredential(value: {
  metadata?: Record<string, unknown>
}): string | undefined {
  return typeof value.metadata?.label === "string"
    ? value.metadata.label
    : undefined
}

/** The real, non-test wiring - shared by both the Effect and Promise plugin entrypoints. */
export const realOAuthDeps: OAuthDeps = {
  refreshAccountsList,
  loadPersistedAccountSource,
  getCachedCredentials,
  setActiveAccountSource,
  saveAccountSource,
  reloadCredentialsFromSource,
  refreshViaOAuth,
  writeBackCredentials,
  log,
}
