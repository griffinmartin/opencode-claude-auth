import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"

it(
  "preserves cooldowns and wait IDs across eight concurrent writer processes",
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "claude-rotation-process-"))
    const rotation = join(root, "rotation.json")
    const waits = join(root, "waits")
    const script = join(root, "writer.mjs")
    writeFileSync(
      script,
      `
import { markRateLimited, clearCooldown, createWaitAttemptId, publishWaitAttempt, clearWaitAttempt } from ${JSON.stringify(new URL("rotation.ts", import.meta.url).href)}
process.send("ready")
process.once("message", async () => {
  const ids = []
  for (let i = 0; i < 32; i++) {
    const source = "worker-" + process.argv[2] + "-" + i
    markRateLimited(source, 60000, "retry-after", 1800000000000)
    const id = createWaitAttemptId()
    publishWaitAttempt(id, { cycle: 1, startedAt: 1800000000000, plannedSource: source, plannedLabel: source, until: 1800000060000, waitMs: 60000 })
    ids.push(id)
    await new Promise(resolve => setImmediate(resolve))
  }
  process.send({ ids })
  process.once("message", () => {
    for (let i = 0; i < 32; i += 2) clearCooldown("worker-" + process.argv[2] + "-" + i)
    for (const id of ids) clearWaitAttempt(id)
    process.disconnect()
  })
})
`,
    )
    const workers = Array.from({ length: 8 }, (_, i) =>
      fork(script, [String(i)], {
        execArgv: ["--import", "tsx"],
        cwd: new URL("../", import.meta.url),
        env: {
          ...process.env,
          HOME: root,
          CLAUDE_AUTH_DEBUG: "0",
          OPENCODE_CLAUDE_AUTH_ROTATION_FILE: rotation,
          OPENCODE_CLAUDE_AUTH_WAIT_DIR: waits,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }),
    )
    const exits = workers.map((worker) => once(worker, "exit"))
    let errors = ""
    for (const worker of workers)
      worker.stderr!.on("data", (data) => {
        errors += data
      })
    t.after(async () => {
      for (const worker of workers) if (worker.exitCode === null) worker.kill()
      await Promise.all(exits)
      rmSync(root, { recursive: true, force: true })
    })
    await Promise.all(workers.map((worker) => once(worker, "message")))
    const reports = workers.map((worker) => once(worker, "message"))
    for (const worker of workers) worker.send("go")
    const results = await Promise.all(reports)
    assert.equal(errors, "")
    const ids = results.flatMap(([report]) => report.ids as string[])
    assert.equal(new Set(ids).size, 256)
    for (const id of ids)
      assert.equal(
        JSON.parse(readFileSync(join(waits, `${id}.json`), "utf8")).version,
        1,
      )
    const state = JSON.parse(readFileSync(rotation, "utf8"))
    assert.equal(
      Object.keys(state.cooldowns).length,
      256,
      "concurrent RMW operations must not erase sibling cooldowns",
    )
    for (const worker of workers) worker.send("cleanup")
    for (const result of await Promise.all(exits)) assert.equal(result[0], 0)
    const remaining = JSON.parse(readFileSync(rotation, "utf8")).cooldowns
    assert.equal(
      Object.keys(remaining).length,
      128,
      "concurrent clears must preserve the other cooldowns",
    )
    assert.ok(
      Object.keys(remaining).every(
        (key) => Number(key.split("-").at(-1)) % 2 === 1,
      ),
    )
  },
)
