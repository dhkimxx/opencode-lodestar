import { Router, type Request, type Response } from "./router"
import { registerAll } from "./routes"

export interface App {
  router: Router
  handle(request: Request): Response
}

export function createApp(): App {
  const router = new Router()
  registerAll(router)
  return {
    router,
    handle(request) {
      const match = router.match(request.method, request.path)
      if (!match) return { status: 404, body: { error: "not found" } }
      const { route, params } = match
      if (route.auth !== "public" && !request.user) return { status: 401, body: { error: "sign in first" } }
      if (route.auth === "admin" && !request.user?.admin) return { status: 403, body: { error: "admins only" } }
      return route.handler(request, params)
    },
  }
}
