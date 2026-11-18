"use client"

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import {
  getSideQuestionCapability,
  supportsNativeSideQuestion,
  type NativeSideQuestionCapability,
} from "@/lib/side-question"
import { getTransport } from "@/lib/transport"
import type { Transport } from "@/lib/transport/types"
import type { AgentType } from "@/lib/types"

interface NativeSideQuestionAvailability extends NativeSideQuestionCapability {
  resolved: boolean
}

const UNAVAILABLE: NativeSideQuestionAvailability = {
  supported: false,
  images: false,
  resolved: true,
}
const CHECKING = { ...UNAVAILABLE, resolved: false }
const pending = new WeakMap<
  Transport,
  Map<string, Promise<NativeSideQuestionCapability>>
>()

export function useNativeSideQuestion(
  source: {
    id: string
    conversationId: number | null
    agentType: AgentType
  } | null
): NativeSideQuestionAvailability {
  const store = useOptionalConnectionStore()
  const tabId = source?.id
  const subscribe = useCallback(
    (listener: () => void) =>
      tabId && store ? store.subscribeKey(tabId, listener) : () => {},
    [store, tabId]
  )
  const snapshot = useCallback(
    () => (tabId ? store?.getConnection(tabId) : undefined),
    [store, tabId]
  )
  const connection = useSyncExternalStore(subscribe, snapshot, () => undefined)
  const sourceAgent = source?.agentType
  const conversationId = source?.conversationId ?? null
  const modelOption = connection?.configOptions?.find(
    (option) => option.id === "model" || option.category === "model"
  )
  const modelValue =
    modelOption?.kind.type === "select"
      ? modelOption.kind.current_value.trim()
      : null
  const ready =
    supportsNativeSideQuestion(sourceAgent ?? "") &&
    connection != null &&
    connection.agentType === sourceAgent &&
    Boolean(connection.connectionId && connection.sessionId) &&
    (connection.status === "connected" || connection.status === "prompting") &&
    connection.selectorsReady &&
    Boolean(modelValue) &&
    !connection.configStale
  const connectionId = ready ? connection?.connectionId : null
  const sessionId = ready ? connection?.sessionId : null
  const transport =
    ready && typeof window !== "undefined" ? getTransport() : null
  const key = connectionId
    ? JSON.stringify([
        connectionId,
        sessionId,
        conversationId,
        sourceAgent,
        modelValue,
      ])
    : null
  const [result, setResult] = useState<{
    key: string
    transport: Transport
    capability: NativeSideQuestionAvailability
  } | null>(null)

  useEffect(() => {
    if (!key || !connectionId || !sourceAgent || !transport) return
    let live = true
    let requests = pending.get(transport)
    if (!requests) {
      requests = new Map()
      pending.set(transport, requests)
    }
    let request = requests.get(key)
    if (!request) {
      request = getSideQuestionCapability(transport, {
        sourceConnectionId: connectionId,
        sourceConversationId: conversationId,
        sourceAgentType: sourceAgent,
      }).catch(() => UNAVAILABLE)
      requests.set(key, request)
      // 多个入口共享正在执行的探测；结果不长期缓存，升级或重连后重新核实。
      void request.finally(() => {
        if (requests.get(key) === request) requests.delete(key)
      })
    }
    void request.then((capability) => {
      if (live) {
        setResult({
          key,
          transport,
          capability: { ...capability, resolved: true },
        })
      }
    })
    return () => {
      live = false
    }
  }, [key, connectionId, sourceAgent, conversationId, transport])

  return key && result?.key === key && result.transport === transport
    ? result.capability
    : sourceAgent && !supportsNativeSideQuestion(sourceAgent)
      ? UNAVAILABLE
      : CHECKING
}
