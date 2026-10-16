import { describe, expect, test } from "bun:test"
import { createApp } from "../src/server"

const user = { id: "u1", admin: false }
const admin = { id: "u9", admin: true }

describe("routes", () => {
  test("lists users for signed-in users only", () => {
    const app = createApp()
    expect(app.handle({ method: "GET", path: "/users" }).status).toBe(401)
    expect(app.handle({ method: "GET", path: "/users", user }).status).toBe(200)
  })

  test("reads route parameters", () => {
    const app = createApp()
    expect(app.handle({ method: "GET", path: "/users/u2", user }).body).toEqual({ id: "u2", name: "Linus" })
    expect(app.handle({ method: "GET", path: "/users/nope", user }).status).toBe(404)
  })

  test("keeps admin routes for admins", () => {
    const app = createApp()
    expect(app.handle({ method: "GET", path: "/admin/stats", user }).status).toBe(403)
    expect(app.handle({ method: "GET", path: "/admin/stats", user: admin }).status).toBe(200)
  })

  test("registers admin routes last", () => {
    const names = createApp().router.list().map((route) => route.name)
    expect(names.at(-1)).toBe("admin.stats")
  })
})
