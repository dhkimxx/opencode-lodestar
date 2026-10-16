import { getStats } from "../handlers/admin"
import type { Router } from "../router"

export function registerAdminRoutes(router: Router): void {
  router.register({
    method: "GET",
    path: "/admin/stats",
    name: "admin.stats",
    auth: "admin",
    rateLimit: { perMinute: 10 },
    tags: ["admin"],
    handler: getStats,
  })
}
