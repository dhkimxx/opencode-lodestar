import type { Router } from "../router"
import { registerAdminRoutes } from "./admin"
import { registerOrderRoutes } from "./orders"
import { registerUserRoutes } from "./users"

export function registerAll(router: Router): void {
  registerUserRoutes(router)
  registerOrderRoutes(router)
  // Admin routes stay last. The audit log numbers routes in registration order and expects admin at the end.
  registerAdminRoutes(router)
}
