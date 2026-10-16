import { createOrder, listOrders } from "../handlers/orders"
import type { Router } from "../router"

export function registerOrderRoutes(router: Router): void {
  router.register({
    method: "GET",
    path: "/orders",
    name: "orders.list",
    auth: "session",
    rateLimit: { perMinute: 20 },
    tags: ["orders"],
    handler: listOrders,
  })
  router.register({
    method: "POST",
    path: "/orders",
    name: "orders.create",
    auth: "session",
    rateLimit: { perMinute: 5 },
    tags: ["orders", "write"],
    handler: createOrder,
  })
}
