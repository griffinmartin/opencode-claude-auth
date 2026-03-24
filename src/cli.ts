#!/usr/bin/env node
import { startServer } from "./server.js"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.js"
import {
  initAccounts,
  setActiveAccountSource,
  loadPersistedAccountSource,
} from "./credentials.js"
import type { Server as HttpServer } from "node:http"

interface ServeOptions {
  port: number
  bind: string
  apiKey: string
}

function printServeHelp(): void {
  console.log(`Usage: opencode-claude-auth serve [options]

Start the credential proxy server

Options:
  -p, --port <number>    Port to listen on (default: 8765, env: OPENAUTH_PORT)
  -b, --bind <address>   Address to bind to (default: 127.0.0.1, env: OPENAUTH_BIND)
  -k, --api-key <key>    API key for authentication (required, env: OPENAUTH_API_KEY)
  -h, --help             Show this help message`)
}

function printMainHelp(): void {
  console.log(`Usage: opencode-claude-auth <command>

Commands:
  serve    Start the credential proxy server

Run "opencode-claude-auth serve --help" for more information on the serve command.`)
}

function parseServeArgs(args: string[]): ServeOptions | null {
  const options: ServeOptions = {
    port: parseInt(process.env.OPENAUTH_PORT ?? "8765", 10),
    bind: process.env.OPENAUTH_BIND ?? "127.0.0.1",
    apiKey: process.env.OPENAUTH_API_KEY ?? "",
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]

    if (arg === "--help" || arg === "-h") {
      printServeHelp()
      process.exit(0)
    }

    if (arg === "--port" || arg === "-p") {
      const value = args[i + 1]
      if (!value) {
        console.error("Error: --port requires a value")
        process.exit(1)
      }
      const port = parseInt(value, 10)
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        console.error(
          `Error: Invalid port "${value}". Must be a number between 1 and 65535.`,
        )
        process.exit(1)
      }
      options.port = port
      i += 2
      continue
    }

    if (arg === "--bind" || arg === "-b") {
      const value = args[i + 1]
      if (!value) {
        console.error("Error: --bind requires a value")
        process.exit(1)
      }
      options.bind = value
      i += 2
      continue
    }

    if (arg === "--api-key" || arg === "-k") {
      const value = args[i + 1]
      if (!value) {
        console.error("Error: --api-key requires a value")
        process.exit(1)
      }
      options.apiKey = value
      i += 2
      continue
    }

    // Unknown flag
    if (arg.startsWith("-")) {
      console.error(`Error: Unknown option "${arg}"`)
      printServeHelp()
      process.exit(1)
    }

    // Unknown positional argument
    console.error(`Error: Unexpected argument "${arg}"`)
    printServeHelp()
    process.exit(1)
  }

  return options
}

function validateOptions(options: ServeOptions): void {
  if (!options.apiKey) {
    console.error(
      "Error: API key is required. Set OPENAUTH_API_KEY environment variable or use --api-key flag.",
    )
    process.exit(1)
  }

  if (options.port < 1 || options.port > 65535) {
    console.error(
      `Error: Invalid port ${options.port}. Must be between 1 and 65535.`,
    )
    process.exit(1)
  }
}

let server: HttpServer | null = null

function setupGracefulShutdown(): void {
  const shutdown = (): void => {
    console.log("Shutting down...")
    if (server) {
      server.close()
    }
    process.exit(0)
  }

  // SIGINT works on Unix and Windows (Ctrl+C)
  process.on("SIGINT", shutdown)

  // 'exit' event for Windows compatibility (SIGTERM doesn't work reliably on Windows)
  process.on("exit", () => {
    if (server) {
      server.close()
    }
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    printMainHelp()
    process.exit(1)
  }

  const command = args[0]

  if (command === "serve") {
    const serveArgs = args.slice(1)
    const options = parseServeArgs(serveArgs)
    if (!options) {
      process.exit(1)
    }
    validateOptions(options)

    // Initialize credential system
    let accounts: ClaudeAccount[]
    try {
      accounts = readAllClaudeAccounts()
    } catch (err) {
      console.warn(
        "Warning: Failed to read Claude Code credentials:",
        err instanceof Error ? err.message : String(err),
      )
      accounts = []
    }

    if (accounts.length === 0) {
      console.warn(
        "Warning: No Claude Code credentials found. Server will return 503 on credential requests.",
      )
    } else {
      initAccounts(accounts)

      const persistedSource = loadPersistedAccountSource()
      const defaultAccount =
        (persistedSource &&
          accounts.find((a) => a.source === persistedSource)) ||
        accounts[0]

      setActiveAccountSource(defaultAccount.source)
    }

    setupGracefulShutdown()

    try {
      server = await startServer({
        port: options.port,
        bind: options.bind,
        apiKey: options.apiKey,
      })
    } catch (err) {
      console.error(
        "Failed to start server:",
        err instanceof Error ? err.message : String(err),
      )
      process.exit(1)
    }
  } else {
    console.error(`Error: Unknown command "${command}"`)
    printMainHelp()
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(
    "Fatal error:",
    err instanceof Error ? err.message : String(err),
  )
  process.exit(1)
})
