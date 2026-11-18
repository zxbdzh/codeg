import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ConnectionState } from "@/contexts/acp-connections-context"
import type { AgentType } from "@/lib/types"

const scene = vi.hoisted(() => ({
  connection: undefined as ConnectionState | undefined,
  listeners: new Set<() => void>(),
  transport: { call: vi.fn() },
  store: {
    getConnection: vi.fn(),
    subscribeKey: vi.fn(),
  },
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useOptionalConnectionStore: () => scene.store,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => scene.transport,
}))

import { useNativeSideQuestion } from "./use-native-side-question"

const source = {
  id: "tab",
  conversationId: 12,
  agentType: "codex" as AgentType,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe("native side-question availability", () => {
  beforeEach(() => {
    scene.listeners.clear()
    scene.transport = {
      call: vi.fn().mockResolvedValue({ supported: true, images: true }),
    }
    scene.connection = {
      connectionId: "connection",
      sessionId: "native-session",
      agentType: "codex",
      status: "connected",
      selectorsReady: true,
      configStale: false,
      configOptions: [
        {
          id: "model",
          category: "model",
          kind: {
            type: "select",
            current_value: "native-model",
            options: [],
            groups: [],
          },
        },
      ],
    } as ConnectionState
    scene.store.getConnection.mockImplementation(() => scene.connection)
    scene.store.subscribeKey.mockImplementation(
      (_key: string, listener: () => void) => {
        scene.listeners.add(listener)
        return () => scene.listeners.delete(listener)
      }
    )
  })

  it.each(["codex", "claude_code", "pi", "deepseek"] as const)(
    "offers %s only after its actual native runtime is verified",
    async (agentType) => {
      scene.connection = { ...scene.connection!, agentType }
      const { result } = renderHook(() =>
        useNativeSideQuestion({ ...source, agentType })
      )
      expect(result.current.supported).toBe(false)
      await waitFor(() => expect(result.current.supported).toBe(true))
      expect(scene.transport.call).toHaveBeenCalledWith(
        "side_question_capability",
        {
          sourceConnectionId: "connection",
          sourceConversationId: 12,
          sourceAgentType: agentType,
        }
      )
    }
  )

  it.each(["gemini", "open_code"] as const)(
    "hides %s when there is no callable native plugin bridge",
    (agentType) => {
      scene.connection = { ...scene.connection!, agentType }
      const { result } = renderHook(() =>
        useNativeSideQuestion({ ...source, agentType })
      )
      expect(result.current.supported).toBe(false)
      expect(scene.transport.call).not.toHaveBeenCalled()
    }
  )

  it.each(["pi", "deepseek"] as const)(
    "hides %s when its installed plugin cannot be called",
    async (agentType) => {
      scene.connection = { ...scene.connection!, agentType }
      scene.transport.call.mockResolvedValue({
        supported: false,
        images: false,
      })
      const { result } = renderHook(() =>
        useNativeSideQuestion({ ...source, agentType })
      )
      await waitFor(() => expect(result.current.resolved).toBe(true))
      expect(result.current.supported).toBe(false)
      expect(scene.transport.call).toHaveBeenCalledTimes(1)
    }
  )

  it("hides the entry while a native session has not been created", () => {
    scene.connection = { ...scene.connection!, sessionId: null }
    const { result } = renderHook(() => useNativeSideQuestion(source))
    expect(result.current.supported).toBe(false)
    expect(scene.transport.call).not.toHaveBeenCalled()
  })

  it("rechecks plugin availability when the live model changes", async () => {
    const { result } = renderHook(() => useNativeSideQuestion(source))
    await waitFor(() => expect(result.current.supported).toBe(true))
    scene.transport.call.mockResolvedValue({ supported: false, images: false })
    act(() => {
      scene.connection = {
        ...scene.connection!,
        configOptions: scene.connection!.configOptions!.map((option) => ({
          ...option,
          kind: {
            ...option.kind,
            current_value: "replacement-model",
          },
        })),
      } as ConnectionState
      scene.listeners.forEach((listener) => listener())
    })
    await waitFor(() => expect(scene.transport.call).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.resolved).toBe(true))
    expect(result.current.supported).toBe(false)
  })

  it("keeps the entry hidden when runtime probing fails", async () => {
    scene.transport.call.mockRejectedValue(new Error("old backend"))
    const { result } = renderHook(() => useNativeSideQuestion(source))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.supported).toBe(false)
    expect(scene.transport.call).toHaveBeenCalledTimes(1)
  })

  it("ignores a late positive probe from a previous connection", async () => {
    const old = deferred<{ supported: boolean; images: boolean }>()
    scene.transport.call
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ supported: false, images: false })
    const { result } = renderHook(() => useNativeSideQuestion(source))
    act(() => {
      scene.connection = {
        ...scene.connection!,
        connectionId: "replacement",
        sessionId: "replacement-session",
      }
      scene.listeners.forEach((listener) => listener())
    })
    await waitFor(() => expect(scene.transport.call).toHaveBeenCalledTimes(2))
    await act(async () => {
      old.resolve({ supported: true, images: true })
      await old.promise
    })
    expect(result.current.supported).toBe(false)
  })

  it("shares a pending probe between the sidebar and selection entry points", async () => {
    const pending = deferred<{ supported: boolean; images: boolean }>()
    scene.transport.call.mockReturnValue(pending.promise)
    const first = renderHook(() => useNativeSideQuestion(source))
    const second = renderHook(() => useNativeSideQuestion(source))
    expect(scene.transport.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve({ supported: true, images: false })
      await pending.promise
    })
    expect(first.result.current).toEqual({
      supported: true,
      images: false,
      resolved: true,
    })
    expect(second.result.current).toEqual({
      supported: true,
      images: false,
      resolved: true,
    })
  })
})
