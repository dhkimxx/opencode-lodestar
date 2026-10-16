// The parts of `opencode session export` output that the harness reads. Fields we don't use are left out.

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface ToolPart {
  type: "tool"
  id: string
  name: string
  state: {
    status: string
    input?: Record<string, unknown>
    content?: { type: string; text?: string }[]
    metadata?: Record<string, unknown>
  }
  time?: { created?: number; ran?: number; completed?: number }
}

export interface TextPart {
  type: "text" | "reasoning"
  text: string
}

export type ContentPart = ToolPart | TextPart | { type: string }

export interface UserMessage {
  type: "user"
  id: string
  time: { created: number }
  text: string
}

export interface AssistantMessage {
  type: "assistant"
  id: string
  time: { created: number; completed?: number }
  content: ContentPart[]
  finish?: string
  tokens?: Tokens
  cost?: number
}

export interface CompactionMessage {
  type: "compaction"
  id: string
  time: { created: number }
  status: string
  reason: string
  summary?: string
  recent?: string
  tokens?: Tokens
  cost?: number
}

export interface OtherMessage {
  type: string
  id: string
  time: { created: number }
}

export type Message = UserMessage | AssistantMessage | CompactionMessage | OtherMessage

export interface SessionExport {
  info: {
    id: string
    cost?: number
    tokens?: Tokens
    outcome?: string
    time: { created: number; updated?: number; idle?: number }
  }
  messages: Message[]
}

export const isAssistant = (message: Message): message is AssistantMessage => message.type === "assistant"
export const isCompaction = (message: Message): message is CompactionMessage => message.type === "compaction"
export const isUser = (message: Message): message is UserMessage => message.type === "user"
export const isTool = (part: ContentPart): part is ToolPart => part.type === "tool"
