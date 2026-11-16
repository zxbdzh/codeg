import { getTransport } from "@/lib/transport"
import { randomUUID } from "@/lib/utils"

export interface EgoConfig {
  enabled: boolean
  endpoint: string
  serverName: string
}

export interface EgoSession {
  contextMenu?: {
    handled: boolean
    linkUrl: string | null
    selection: string
    editable: boolean
  }
  views?: Record<string, string | null>
  revision: number
  sessionId: number
  spaceId: number | null
  tabs: { id: string; url: string; title: string; live: boolean }[]
  downloads: {
    id: string
    name: string
    state: string
    bytes: number
    total: number
  }[]
  control: { owner: string | null; epoch: number; recoveryRequired: boolean }
  blocked: string | null
  connected: boolean
  evalRequest: { id: string; code: string; tabId: string } | null
}

export interface EgoFrame {
  data: string
  format?: "jpeg" | "png"
  width: number
  height: number
  chooser: { mode: string } | null
  dialog: { type: string; message: string; defaultPrompt?: string } | null
}

export function egoRequest<Result>(request: Record<string, unknown>) {
  return getTransport().call<Result>("ego_browser", { request })
}

let fallbackClient: string | null = null

export function egoClientId(): string {
  const key = "ego:device-id"
  try {
    let client = localStorage.getItem(key)
    if (!client) {
      // 局域网 HTTP 没有原生 randomUUID；复用兼容实现，避免面板初始化时崩溃。
      client = randomUUID()
      localStorage.setItem(key, client)
    }
    return client
  } catch {
    fallbackClient ??= randomUUID()
    return fallbackClient
  }
}

export function egoError(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message)
  }
  return "Ego 操作失败，请检查连接和真实页面。"
}
