import { getUser, listUsers } from "../handlers/users"
import type { Router } from "../router"

export function registerUserRoutes(router: Router): void {
  router.register({
    method: "GET",
    path: "/users",
    name: "users.list",
    auth: "session",
    rateLimit: { perMinute: 30 },
    tags: ["users"],
    handler: listUsers,
  })
  router.register({
    method: "GET",
    path: "/users/:id",
    name: "users.get",
    auth: "session",
    rateLimit: { perMinute: 30 },
    tags: ["users"],
    handler: getUser,
  })
}
