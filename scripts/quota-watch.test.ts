import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { formatSessionStatus, loadSessionStatus } from "./quota-watch.mjs"

const script = fileURLToPath(new URL("./quota-watch.mjs", import.meta.url))

describe("quota-watch", () => {
  it("renders the native retry timestamp as a ticking countdown without printing provider errors", () => {
    const now = Date.UTC(2026, 8, 25, 20)
    const snapshot = {
      status: {
        type: "retry",
        attempt: 2,
        next: now + 3661_000,
        message: "DO_NOT_PRINT_ERROR_CONTENT",
      },
    }
    assert.match(
      formatSessionStatus(snapshot, now, "UTC"),
      /retry #2: 01:01:01/,
    )
    assert.match(formatSessionStatus(snapshot, now + 1000, "UTC"), /01:01:00/)
    assert.match(
      formatSessionStatus(snapshot, now + 3662_000, "UTC"),
      /due now; awaiting server update/,
    )
    assert.doesNotMatch(
      formatSessionStatus(snapshot, now, "UTC"),
      /DO_NOT_PRINT_ERROR_CONTENT/,
    )
  })

  it("does not misrepresent idle, busy, unavailable or unscheduled states as a countdown", () => {
    assert.match(
      formatSessionStatus({ status: null }),
      /not reported as busy\/retrying/,
    )
    assert.match(formatSessionStatus({ status: { type: "busy" } }), /busy/)
    assert.match(formatSessionStatus({ error: true }), /cannot be confirmed/)
    assert.match(
      formatSessionStatus({ status: { type: "retry", attempt: 1 } }),
      /no retry time supplied/,
    )
  })

  it("reads only the requested session status from a local server; no auth headers are sent", async () => {
    const requests: string[] = []
    let failed = false
    const server = createServer((request, response) => {
      requests.push(request.url ?? "")
      assert.equal(request.method, "GET")
      assert.equal(request.headers.authorization, undefined)
      assert.equal(request.headers["x-api-key"], undefined)
      response.writeHead(failed ? 503 : 200, {
        "content-type": "application/json",
      })
      response.end(
        JSON.stringify({
          target: { type: "retry", attempt: 1, next: Date.now() + 3600_000 },
          sibling: { type: "busy" },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const url = `http://127.0.0.1:${address.port}`
    try {
      const snapshot = await loadSessionStatus(
        url,
        "target",
        "/tmp/example space",
      )
      assert.equal(snapshot.status?.type, "retry")
      assert.equal(snapshot.status?.attempt, 1)
      assert.equal(
        requests[0],
        "/session/status?directory=%2Ftmp%2Fexample+space",
      )
      const root = mkdtempSync(join(tmpdir(), "claude-session-watch-"))
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          script,
          "--server",
          url,
          "--session",
          "target",
          "--directory",
          "/tmp/example space",
          "--time-zone",
          "Europe/Prague",
        ],
        {
          env: { ...process.env, XDG_DATA_HOME: root },
        },
      )
      assert.match(stdout, /OpenCode retry #1: 01:00:00/)
      assert.match(stdout, /Next scheduled attempt:/)
      failed = true
      assert.deepEqual(
        await loadSessionStatus(url, "target", "/tmp/example space"),
        { error: true },
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("shows concurrent waits, stale requests, and no token material", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-quota-watch-"))
    const data = join(root, "data", "opencode")
    const waits = join(data, "claude-auth-waits")
    mkdirSync(waits, { recursive: true })
    const now = Date.now()
    writeFileSync(
      join(data, "claude-auth-rotation.json"),
      JSON.stringify({
        version: 1,
        cooldowns: { "token:abcd1234": { until: now + 100_000 } },
      }),
    )
    writeFileSync(
      join(data, "claude-auth-tokens.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "abcd1234",
            label: "Account A",
            token: "sk-ant-oat01-FAKESECRETNEVERPRINT",
          },
        ],
      }),
    )
    writeFileSync(join(data, "claude-account-source.txt"), "token:abcd1234")
    for (const [id, updatedAt] of [
      ["1-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", now],
      ["2-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", now - 600_000],
    ] as const) {
      writeFileSync(
        join(waits, `${id}.json`),
        JSON.stringify({
          version: 1,
          active: {
            plannedSource: "token:abcd1234",
            plannedLabel: "Account A",
            updatedAt,
            until: now + 100_000,
            cycle: 1,
          },
        }),
      )
    }
    const result = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, XDG_DATA_HOME: join(root, "data") },
    })
    assert.match(result, /2 in-flight quota waits/)
    assert.match(result, /STALE/)
    assert.match(result, /Account A/)
    assert.doesNotMatch(result, /FAKESECRETNEVERPRINT/)
  })
})
