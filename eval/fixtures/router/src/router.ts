export type Method = "GET" | "POST" | "PUT" | "DELETE"
export type Auth = "public" | "session" | "admin"

export interface Request {
  method: Method
  path: string
  user?: { id: string; admin: boolean }
  body?: unknown
}

export interface Response {
  status: number
  body: unknown
}

export type Handler = (request: Request, params: Record<string, string>) => Response

export interface RouteDefinition {
  method: Method
  /** Segments starting with `:` are parameters, like `/users/:id`. */
  path: string
  /** `<area>.<action>`, unique across the app. Logs and metrics use it. */
  name: string
  auth: Auth
  rateLimit: { perMinute: number }
  tags: string[]
  handler: Handler
}

interface Match {
  route: RouteDefinition
  params: Record<string, string>
}

export class Router {
  private readonly routes: RouteDefinition[] = []

  register(route: RouteDefinition) {
    if (!/^[a-z]+\.[a-z]+$/.test(route.name)) throw new Error(`route name must look like area.action: ${route.name}`)
    if (this.routes.some((existing) => existing.name === route.name)) throw new Error(`duplicate route name: ${route.name}`)
    if (route.rateLimit.perMinute <= 0) throw new Error(`rate limit must be positive: ${route.name}`)
    this.routes.push(route)
  }

  list(): readonly RouteDefinition[] {
    return this.routes
  }

  match(method: Method, path: string): Match | undefined {
    const parts = path.split("/").filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== method) continue
      const pattern = route.path.split("/").filter(Boolean)
      if (pattern.length !== parts.length) continue
      const params: Record<string, string> = {}
      const matches = pattern.every((segment, index) => {
        const part = parts[index] ?? ""
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = part
          return true
        }
        return segment === part
      })
      if (matches) return { route, params }
    }
    return undefined
  }
}
