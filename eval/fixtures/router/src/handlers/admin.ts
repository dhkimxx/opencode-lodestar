import type { Handler } from "../router"

export const getStats: Handler = () => ({ status: 200, body: { users: 2, orders: 1 } })
