import type { Handler } from "../router"

const orders = [{ id: "o1", userID: "u1", totalCents: 4200 }]

export const listOrders: Handler = (request) => ({
  status: 200,
  body: orders.filter((order) => request.user?.admin || order.userID === request.user?.id),
})

export const createOrder: Handler = (request) => {
  const body = request.body as { totalCents?: unknown } | undefined
  if (typeof body?.totalCents !== "number") return { status: 400, body: { error: "totalCents is required" } }
  const order = { id: `o${orders.length + 1}`, userID: request.user?.id ?? "", totalCents: body.totalCents }
  orders.push(order)
  return { status: 201, body: order }
}
