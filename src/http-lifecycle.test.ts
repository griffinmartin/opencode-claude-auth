import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, type TestContext } from "node:test"
import {
  fetchWithHeaderDeadline,
  fetchWithRetry,
  sleepUntilStateChange,
  stateRevision,
  type FetchFn,
} from "./http.ts"

const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const watchers = () =>
  process.getActiveResourcesInfo().filter((name) => name === "FSEventWrap")
    .length
const stalled: FetchFn = async (_input, init) =>
  new Promise((_resolve, reject) => {
    init!.signal!.addEventListener(
      "abort",
      () => reject(init!.signal!.reason),
      { once: true },
    )
  })
const directory = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "claude-http-lifecycle-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

describe(
  "wait watcher lifecycle",
  { concurrency: false, timeout: 5_000 },
  () => {
    it("wakes on atomic replacement but ignores unrelated sibling files", async (t) => {
      const root = directory(t)
      const path = join(root, "state.json")
      writeFileSync(path, "one")
      const controller = new AbortController()
      t.after(() => controller.abort())
      let finished = false
      const pending = sleepUntilStateChange(2_000, controller.signal, [
        path,
      ]).then(() => {
        finished = true
      })
      writeFileSync(join(root, "unrelated"), "noise")
      await tick(20)
      assert.equal(finished, false)
      writeFileSync(`${path}.new`, "two")
      renameSync(`${path}.new`, path)
      await pending
      assert.equal(getEventListeners(controller.signal, "abort").length, 0)
    })

    it("detects a change between revision capture and watcher registration", async (t) => {
      const path = join(directory(t), "state.json")
      writeFileSync(path, "before")
      const revision = stateRevision([path])
      writeFileSync(path, "after registration race")
      const start = Date.now()
      await sleepUntilStateChange(2_000, undefined, [path], revision)
      assert.ok(Date.now() - start < 500)
    })

    it("uses its timer if the parent directory does not yet exist", async (t) => {
      const path = join(directory(t), "missing", "state.json")
      await sleepUntilStateChange(5, undefined, [path])
    })

    it("releases all watchers and abort listeners after 256 parallel waits", async (t) => {
      const path = join(directory(t), "state.json")
      writeFileSync(path, "original")
      await tick()
      const baseline = watchers()
      const controllers = Array.from(
        { length: 256 },
        () => new AbortController(),
      )
      t.after(() => controllers.forEach((c) => c.abort()))
      const requests = controllers.map((controller) =>
        sleepUntilStateChange(2_000, controller.signal, [path]),
      )
      const all = Promise.allSettled(requests)
      assert.equal(watchers(), baseline + 256)
      for (const c of controllers.slice(0, 128)) c.abort()
      writeFileSync(`${path}.new`, "changed")
      renameSync(`${path}.new`, path)
      const results = await all
      assert.equal(results.filter((r) => r.status === "rejected").length, 128)
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 128)
      await tick(20)
      assert.equal(watchers(), baseline)
      assert.ok(
        controllers.every(
          (c) => getEventListeners(c.signal, "abort").length === 0,
        ),
      )
    })

    it("does not leak handles through 100 sequential timer completions", async (t) => {
      const path = join(directory(t), "state.json")
      await tick()
      const baseline = watchers()
      for (let i = 0; i < 100; i++) {
        const controller = new AbortController()
        await sleepUntilStateChange(1, controller.signal, [path])
        assert.equal(getEventListeners(controller.signal, "abort").length, 0)
      }
      await tick(20)
      assert.equal(watchers(), baseline)
    })
  },
)

describe("network deadline and retry lifecycle", { timeout: 5_000 }, () => {
  it("terminates a network attempt which never supplies headers", async () => {
    await assert.rejects(
      fetchWithHeaderDeadline("https://example.test", {}, stalled, 10),
      { name: "TimeoutError" },
    )
  })

  it("keeps caller cancellation connected to the stream after clearing the header timer", async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const streamFetch: FetchFn = async (_input, init) => {
      requestSignal = init!.signal!
      return new Response(
        new ReadableStream({
          start(stream) {
            requestSignal!.addEventListener(
              "abort",
              () => stream.error(requestSignal!.reason),
              { once: true },
            )
          },
        }),
      )
    }
    const response = await fetchWithHeaderDeadline(
      "https://example.test",
      { signal: controller.signal },
      streamFetch,
      10,
    )
    await tick(30)
    assert.equal(
      requestSignal!.aborted,
      false,
      "the header timer must not kill an already-open stream",
    )
    controller.abort()
    await assert.rejects(response.text(), { name: "AbortError" })
  })

  it("cancels discarded 529 bodies before retrying", async () => {
    let canceled = false
    let calls = 0
    const capacity: FetchFn = async () => {
      if (calls++ > 0) {
        assert.equal(
          canceled,
          true,
          "release the previous network body before the next attempt",
        )
        return new Response("ok")
      }
      return new Response(
        new ReadableStream({
          cancel() {
            canceled = true
          },
        }),
        {
          status: 529,
          headers: { "retry-after": "0" },
        },
      )
    }
    assert.equal(
      (await fetchWithRetry("https://example.test", {}, 3, capacity)).status,
      200,
    )
    assert.equal(calls, 2)
  })

  it("honors an already-aborted Request signal when no init.signal is supplied", async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await assert.rejects(
      fetchWithRetry(
        new Request("https://example.test", { signal: controller.signal }),
        undefined,
        3,
        async () => {
          calls++
          return new Response("unexpected")
        },
      ),
      { name: "AbortError" },
    )
    assert.equal(calls, 0)
  })
})
