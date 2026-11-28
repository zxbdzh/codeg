import { act, render, screen } from "@testing-library/react"
import { useEffect } from "react"
import type {
  ConversationChange,
  DbConversationSummary,
  PromptDraft,
} from "@/lib/types"
import {
  loadSideQuestionDraft,
  saveSideQuestionDraft,
} from "@/lib/side-question-draft"
import { beforeEach, describe, expect, it, vi } from "vitest"

const scene = vi.hoisted(() => ({
  parentId: 1,
  remote: null as number | null,
  isOpen: true,
  activeTab: "side_question",
  listener: null as null | ((event: ConversationChange) => void),
  mounts: vi.fn(),
  unmounts: vi.fn(),
  props: new Map<number, Record<string, unknown>>(),
  register: vi.fn(),
  active: vi.fn(),
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => scene,
}))
const connections = new Map<
  string,
  {
    status: string
    backgroundOutstanding: number
    asyncTasks: never[]
    remoteControl: null
    delegatedChildren: never[]
  }
>()
const listeners = new Map<string, () => void>()
const connectionStore = {
  getConnection: (key: string) => connections.get(key),
  subscribeKey: (key: string, listener: () => void) => {
    listeners.set(key, listener)
    return () => {
      listeners.delete(key)
    }
  },
}
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    registerLiveSurfaceKeys: scene.register,
    setActiveKey: scene.active,
  }),
  useConnectionStore: () => connectionStore,
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: { getState: () => ({ activeTabId: "main" }) },
}))
vi.mock("@/hooks/use-side-question-source", () => ({
  useSideQuestionSource: () => ({ parentId: scene.parentId }),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: (_event: string, listener: typeof scene.listener) => {
    scene.listener = listener
    return Promise.resolve(() => {})
  },
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => scene.remote,
}))
vi.mock("@/components/canvas/canvas-conversation-surface", () => ({
  CanvasConversationSurface: (props: {
    conversationId: number
    isActive: boolean
    connectInBackground: boolean
  }) => {
    scene.props.set(props.conversationId, props)
    useEffect(() => {
      scene.mounts(props.conversationId)
      return () => scene.unmounts(props.conversationId)
    }, [props.conversationId])
    return <div data-testid={`surface-${props.conversationId}`} />
  },
}))
import { useSideQuestionPanelStore } from "@/stores/side-question-panel-store"
import {
  loadMessageInputDraft,
  saveMessageInputDraft,
} from "@/lib/message-input-draft"
import { SideQuestionDock, SideQuestionHost } from "./side-question-host"

const target = (conversationId: number, parentConversationId = 1) => ({
  conversationId,
  parentConversationId,
  folderId: 1,
  agentType: "claude_code" as const,
  workingDir: "/tmp",
  readonly: true,
})
function view(dock = true) {
  return <SideQuestionHost>{dock && <SideQuestionDock />}</SideQuestionHost>
}

describe("SideQuestionHost", () => {
  beforeEach(() => {
    localStorage.clear()
    useSideQuestionPanelStore.getState().reset()
    Object.assign(scene, {
      parentId: 1,
      remote: null,
      isOpen: true,
      activeTab: "side_question",
      listener: null,
    })
    scene.mounts.mockClear()
    scene.unmounts.mockClear()
    scene.register.mockClear()
    scene.active.mockClear()
    scene.props.clear()
    connections.clear()
    listeners.clear()
  })
  it("isolates drafts for the same conversation across local and remote backends", () => {
    act(() => useSideQuestionPanelStore.getState().open(target(10)))
    const local = render(view())
    const localKey = `canvas-draft:${scene.props.get(10)?.contextKey}`
    saveMessageInputDraft(localKey, "local draft")
    local.unmount()
    act(() => useSideQuestionPanelStore.getState().reset())

    scene.remote = 1
    act(() => useSideQuestionPanelStore.getState().open(target(10)))
    const remote = render(view())
    const remoteKey = `canvas-draft:${scene.props.get(10)?.contextKey}`
    expect(remoteKey).not.toBe(localKey)
    expect(loadMessageInputDraft(remoteKey)).toBeNull()
    saveMessageInputDraft(remoteKey, "remote draft")
    expect(loadMessageInputDraft(localKey)).toBe("local draft")
    expect(loadMessageInputDraft(remoteKey)).toBe("remote draft")
    remote.unmount()
  })
  it("restores only an editor draft after refresh, and clears only the acknowledged version", () => {
    const draft: PromptDraft = {
      blocks: [
        { type: "text", text: "first question" },
        {
          type: "resource_link",
          uri: "file:///tmp/diagram.png",
          name: "diagram.png",
        },
      ],
      displayText: "first question",
    }
    const initial = { token: "first", draft }
    saveSideQuestionDraft(null, "question", 10, initial)
    saveSideQuestionDraft(1, "question", 10, { ...initial, token: "remote" })
    act(() =>
      useSideQuestionPanelStore.getState().open({
        ...target(10),
        initialSend: { draft, modeId: null, token: initial.token },
      })
    )
    const first = render(view())
    expect(scene.props.get(10)?.initialSend).toBeTruthy()
    first.unmount()
    act(() => {
      useSideQuestionPanelStore.getState().reset()
      useSideQuestionPanelStore.getState().open(target(10))
    })
    render(view())
    expect(scene.props.get(10)).toMatchObject({
      initialSend: null,
      recoveryDraft: draft,
      connectInBackground: false,
    })

    const protect = scene.props.get(10)?.protectRecoverySend as (
      draft: PromptDraft,
      initialToken?: string
    ) => () => void
    const firstReceipt = protect(draft)
    const edited = { ...draft, displayText: "edited" }
    const secondReceipt = protect(edited)
    firstReceipt()
    expect(loadSideQuestionDraft(null, "question", 10)?.draft).toEqual(edited)
    secondReceipt()
    expect(loadSideQuestionDraft(null, "question", 10)).toBeNull()
    expect(loadSideQuestionDraft(1, "question", 10)?.token).toBe("remote")
  })
  it("holds a hidden busy connection and releases it when idle", () => {
    scene.isOpen = false
    const key = `side-question-${JSON.stringify([null, 10])}`
    const connection = {
      status: "prompting",
      backgroundOutstanding: 0,
      asyncTasks: [],
      remoteControl: null,
      delegatedChildren: [],
    }
    connections.set(key, connection)
    act(() => useSideQuestionPanelStore.getState().open(target(10)))
    render(view())
    expect(scene.register).toHaveBeenLastCalledWith(key, new Set([key]))
    act(() => {
      connections.set(key, { ...connection, status: "connected" })
      listeners.get(key)?.()
    })
    expect(scene.register).toHaveBeenLastCalledWith(key, new Set())
    expect(scene.unmounts).not.toHaveBeenCalled()
  })
  it("keeps surfaces mounted across hiding, source switches, dock removal and reselection", async () => {
    act(() => useSideQuestionPanelStore.getState().open(target(10)))
    const { rerender } = render(view())
    expect(screen.getByTestId("surface-10")).toBeVisible()
    scene.isOpen = false
    rerender(view())
    expect(scene.props.get(10)?.isActive).toBe(false)
    scene.parentId = 2
    scene.isOpen = true
    rerender(view(false))
    rerender(view())
    act(() => useSideQuestionPanelStore.getState().open(target(20, 2)))
    expect(screen.getByTestId("surface-20")).toBeVisible()
    scene.parentId = 1
    rerender(view())
    expect(screen.getByTestId("surface-10")).toBeVisible()
    expect(scene.props.get(10)?.contextKey).toBe(
      `side-question-${JSON.stringify([null, 10])}`
    )
    expect(scene.props.get(20)?.contextKey).toBe(
      `side-question-${JSON.stringify([null, 20])}`
    )
    expect(scene.mounts.mock.calls.map(([id]) => id)).toEqual([10, 20])
    expect(scene.unmounts).not.toHaveBeenCalled()
    await act(async () => {
      scene.listener?.({ kind: "deleted", id: 10 })
    })
    expect(scene.unmounts).toHaveBeenCalledWith(10)
    expect(
      useSideQuestionPanelStore.getState().selectedByParent[1]
    ).toBeUndefined()
  })
  it("removes child surfaces when their parent is deleted", async () => {
    act(() => {
      useSideQuestionPanelStore.getState().open(target(10))
      useSideQuestionPanelStore.getState().open(target(11))
      useSideQuestionPanelStore.getState().open(target(20, 2))
    })
    render(view())
    await act(async () => {
      scene.listener?.({ kind: "deleted", id: 1 })
    })
    expect(scene.unmounts.mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining([10, 11])
    )
    expect(useSideQuestionPanelStore.getState().selectedByParent).toEqual({
      2: 20,
    })
    expect(useSideQuestionPanelStore.getState().opened[20]).toBeDefined()
  })
  it("removes a converted question without affecting other surfaces", async () => {
    act(() => {
      useSideQuestionPanelStore.getState().open(target(10))
      useSideQuestionPanelStore.getState().open(target(20, 2))
    })
    render(view())
    await act(async () => {
      scene.listener?.({
        kind: "upsert",
        summary: {
          id: 10,
          kind: "normal",
          parent_id: null,
        } as unknown as DbConversationSummary,
      })
    })
    expect(scene.unmounts).toHaveBeenCalledWith(10)
    expect(useSideQuestionPanelStore.getState().selectedByParent).toEqual({
      2: 20,
    })
    expect(useSideQuestionPanelStore.getState().opened[20]).toBeDefined()
  })
  it("connects a pending first question in the background without making it active", () => {
    scene.isOpen = false
    act(() =>
      useSideQuestionPanelStore.getState().open({
        ...target(10),
        initialSend: {
          draft: {
            blocks: [{ type: "text", text: "hello" }],
            displayText: "hello",
          },
          modeId: null,
          token: "pending",
        },
      })
    )
    render(view())
    expect(scene.props.get(10)).toMatchObject({
      connectInBackground: true,
      isActive: false,
    })
    expect(scene.active).not.toHaveBeenCalledWith("side-question-10")
    expect(scene.mounts).toHaveBeenCalledTimes(1)
  })
})
