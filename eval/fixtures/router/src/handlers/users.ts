import type { Handler } from "../router"

const users = [
  { id: "u1", name: "Ada" },
  { id: "u2", name: "Linus" },
]

export const listUsers: Handler = () => ({ status: 200, body: users })

export const getUser: Handler = (_request, params) => {
  const user = users.find((candidate) => candidate.id === params.id)
  return user ? { status: 200, body: user } : { status: 404, body: { error: "user not found" } }
}
