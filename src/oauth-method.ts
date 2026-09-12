import { Credential, Integration } from "@opencode/plugin"
import type { IntegrationOAuthMethod } from "@opencode/plugin/promise/integration"
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

/** Identifies credentials created by this plugin when OpenCode builds provider options. */
export const CLAUDE_CODE_OAUTH_METADATA_KEY =
  "opencode-claude-auth/claude-code-oauth"
export const CLAUDE_CODE_OAUTH_METADATA_VALUE = "v1"

/** Form field key the account chooser collects its answer under. */
const ACCOUNT_FIELD_KEY = "account"

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

/** A `Form.Answer` as the host collected it from {@link oauthMethodDescriptor}. */
export interface AuthorizeInputs {
  readonly account?: unknown
}

/**
 * `/connect` shows this when the user picks the Claude Code method. With more
 * than one account on the machine it carries a chooser: OpenCode renders a
 * `string` field that has `options` as a pick list (no `custom`, so only a
 * listed account can be chosen) and hands the selection back to `authorize`
 * under the field's key. Each option is described by its credential source,
 * which is what tells two accounts on the same subscription tier apart.
 */
export function oauthMethodDescriptor(
  accounts: readonly ClaudeAccount[],
): IntegrationOAuthMethod {
  const method = {
    id: METHOD_ID,
    type: "oauth",
    label: "Import Claude Code subscription",
  } as const
  if (accounts.length <= 1) return method
  return {
    ...method,
    form: [
      {
        type: "string",
        key: ACCOUNT_FIELD_KEY,
        title: "Select a Claude Code account",
        required: true,
        options: accounts.map((account) => ({
          value: account.source,
          label: account.label,
          description: account.source,
        })),
      },
    ],
  }
}

export function resolveAuthorizeSource(
  inputs: AuthorizeInputs,
  fallbackAccounts: readonly ClaudeAccount[],
  deps: Pick<OAuthDeps, "refreshAccountsList" | "loadPersistedAccountSource">,
): string | undefined {
  const latest = deps.refreshAccountsList()
  const chosen = inputs[ACCOUNT_FIELD_KEY]
  return (
    (typeof chosen === "string" ? chosen : undefined) ??
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
      [CLAUDE_CODE_OAUTH_METADATA_KEY]: CLAUDE_CODE_OAUTH_METADATA_VALUE,
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
