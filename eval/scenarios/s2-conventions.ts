import path from "node:path"
import { compact, runHiddenTest, runTests, share, turn, type Scenario } from "../lib/scenario"

// The agent studies the route files, a compaction drops them, and then it must follow details it read earlier.
const HIDDEN = `
import { expect, test } from "bun:test"
import { createApp } from "../src/server"

const route = () => createApp().router.list().find((candidate) => candidate.path === "/health")

test("health route file exports registerHealthRoutes", async () => {
  const module = await import("../src/routes/health")
  expect(typeof module.registerHealthRoutes).toBe("function")
})

test("GET /health answers without a session", () => {
  expect(createApp().handle({ method: "GET", path: "/health" })).toEqual({ status: 200, body: { status: "ok" } })
})

test("health route is public", () => {
  expect(route()?.auth).toBe("public")
})

test("health route uses the users rate limit", () => {
  expect(route()?.rateLimit).toEqual({ perMinute: 30 })
})

test("health route name and tags follow the area convention", () => {
  expect(route()?.name.startsWith("health.")).toBe(true)
  expect(route()?.tags[0]).toBe("health")
})

test("admin routes still register last", () => {
  expect(createApp().router.list().at(-1)?.name).toBe("admin.stats")
})
`

export const s2: Scenario = {
  id: "S2",
  title: "Conventions read before a compaction are followed after it",
  fixture: "router",
  steps: [
    turn(
      "Read src/router.ts, src/server.ts, and every file in src/routes/ and src/handlers/. Explain how routes are defined and registered: every field a route definition sets, and the conventions the existing route files follow. Don't change anything yet.",
    ),
    compact,
    turn(
      'Add a GET /health endpoint. Put the route in a new file src/routes/health.ts and the handler in src/handlers/health.ts, following the existing conventions exactly: the register function name, the route name format, the tags, and how it is wired into registerAll. It must be public and use the same rate limit as the users routes. It returns status 200 with the body { status: "ok" }. Add a test in test/health.test.ts and run all the tests.',
    ),
  ],
  async check({ workdir }) {
    const tests = await runTests(workdir)
    const handlerFile = await Bun.file(path.join(workdir, "src/handlers/health.ts")).exists()
    const hidden = await runHiddenTest(workdir, "s2", HIDDEN)
    const hiddenResults = [...hidden.results.values()]
    const checks = [tests.failed === 0 && tests.passed > 0, handlerFile, ...hiddenResults]
    return {
      success: checks.every(Boolean) && hiddenResults.length === 6,
      score: share(checks),
      violations: 0,
      notes: [
        `tests ${tests.passed} passed, ${tests.failed} failed`,
        `handler file ${handlerFile ? "present" : "missing"}`,
        ...[...hidden.results].map(([name, passed]) => `${passed ? "ok" : "FAIL"}: ${name}`),
      ],
    }
  },
}
