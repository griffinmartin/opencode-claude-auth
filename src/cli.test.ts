import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"

const CLI_PATH = resolve(process.cwd(), "dist/cli.js")

function execCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("node", [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      timeout: 5000,
    })

    let stdout = ""
    let stderr = ""

    proc.stdout?.on("data", (data) => {
      stdout += data.toString()
    })

    proc.stderr?.on("data", (data) => {
      stderr += data.toString()
    })

    proc.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
      })
    })

    proc.on("error", (err) => {
      stderr += err.message
      resolve({ stdout, stderr, exitCode: -1 })
    })
  })
}

function waitForOutput(proc: ChildProcess, marker: string, timeout = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for: ${marker}`))
    }, timeout)

    let accumulated = ""

    proc.stdout?.on("data", (data) => {
      accumulated += data.toString()
      if (accumulated.includes(marker)) {
        clearTimeout(timer)
        resolve(accumulated)
      }
    })

    proc.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe("CLI", () => {
  describe("Argument parsing", () => {
    it("1. No arguments → prints help, exits with code 1", async () => {
      const result = await execCli([])
      assert.strictEqual(result.exitCode, 1)
      assert.ok(result.stdout.includes("Usage:"), "Should print usage help")
      assert.ok(result.stdout.includes("Commands:"), "Should list available commands")
      assert.ok(result.stdout.includes("serve"), "Should mention serve command")
    })

    it("2. Unknown command → prints error + help, exits with code 1", async () => {
      const result = await execCli(["unknown"])
      assert.strictEqual(result.exitCode, 1)
      assert.ok(result.stderr.includes('Unknown command "unknown"'), `Should print unknown command error, got: ${result.stderr}`)
      assert.ok(result.stdout.includes("Usage:"), "Should print help")
    })

    it("3. serve --help → prints serve help, exits with code 0", async () => {
      const result = await execCli(["serve", "--help"])
      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.stdout.includes("Usage: opencode-claude-auth serve"), "Should print serve usage")
      assert.ok(result.stdout.includes("--port"), "Should list --port option")
      assert.ok(result.stdout.includes("--bind"), "Should list --bind option")
      assert.ok(result.stdout.includes("--api-key"), "Should list --api-key option")
    })

    it("4. serve without --api-key and without OPENAUTH_API_KEY → prints error about missing API key, exits 1", async () => {
      const result = await execCli(["serve"], { OPENAUTH_API_KEY: "" })
      assert.strictEqual(result.exitCode, 1)
      assert.ok(result.stderr.includes("API key is required"), "Should print API key error")
      assert.ok(result.stderr.includes("OPENAUTH_API_KEY"), "Should mention env var")
    })

    it("5. serve --api-key test123 → starts server", async () => {
      const proc = spawn("node", [CLI_PATH, "serve", "--api-key", "test123", "-p", "19001"], {
        env: process.env,
        timeout: 5000,
      })

      try {
        const output = await waitForOutput(proc, "server_started", 3000)
        assert.ok(output.includes("server_started") || output.includes("Server started"), `Should start server, got: ${output}`)
      } finally {
        proc.kill()
        // Wait for process to exit
        await new Promise<void>((resolve) => {
          proc.on("close", () => resolve())
          setTimeout(resolve, 1000)
        })
      }
    })

    it("6. serve --port 99999 --api-key test → prints invalid port error, exits 1", async () => {
      const result = await execCli(["serve", "--port", "99999", "--api-key", "test"])
      assert.strictEqual(result.exitCode, 1)
      assert.ok(result.stderr.includes("Invalid port"), "Should print invalid port error")
      assert.ok(result.stderr.includes("99999"), "Should mention the invalid port value")
    })

    it("7. serve --port abc --api-key test → prints invalid port error, exits 1", async () => {
      const result = await execCli(["serve", "--port", "abc", "--api-key", "test"])
      assert.strictEqual(result.exitCode, 1)
      assert.ok(result.stderr.includes("Invalid port"), "Should print invalid port error")
      assert.ok(result.stderr.includes("abc"), "Should mention the invalid port value")
    })

    it("8. serve -p 9876 -b 0.0.0.0 -k test123 → starts server on specified port/bind", async () => {
      const proc = spawn("node", [CLI_PATH, "serve", "-p", "9876", "-b", "0.0.0.0", "-k", "test123"], {
        env: process.env,
        timeout: 5000,
      })

      try {
        const output = await waitForOutput(proc, "server_started", 3000)
        assert.ok(output.includes("server_started") || output.includes("Server started"), `Should start server on port 9876, got: ${output}`)
      } finally {
        proc.kill()
        await new Promise<void>((resolve) => {
          proc.on("close", () => resolve())
          setTimeout(resolve, 1000)
        })
      }
    })

    it("9. serve --unknown-flag --api-key test → prints unknown option error, exits 1", async () => {
      const result = await execCli(["serve", "--unknown-flag", "--api-key", "test"])
      assert.strictEqual(result.exitCode, 1)
      assert.ok(result.stderr.includes("Unknown option"), "Should print unknown option error")
      assert.ok(result.stderr.includes("--unknown-flag"), "Should mention the unknown flag")
    })

    it("10. OPENAUTH_API_KEY env var works as alternative to --api-key flag", async () => {
      const proc = spawn("node", [CLI_PATH, "serve", "-p", "19002"], {
        env: { ...process.env, OPENAUTH_API_KEY: "envkey123" },
        timeout: 5000,
      })

      try {
        const output = await waitForOutput(proc, "server_started", 3000)
        assert.ok(output.includes("server_started") || output.includes("Server started"), `Should start server with env API key, got: ${output}`)
      } finally {
        proc.kill()
        await new Promise<void>((resolve) => {
          proc.on("close", () => resolve())
          setTimeout(resolve, 1000)
        })
      }
    })
  })
})
