import { beforeEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({ id: null as number | null }))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => backend.id,
}))
import { useSideQuestionPanelStore as store } from "./side-question-panel-store"

const source = (id: number) => ({
  parentConversationId: id,
  agentType: "claude_code" as const,
  folderId: 1,
  workingDir: "/workspace",
})

const question = (id: number, parent = 1) => ({
  ...source(parent),
  conversationId: id,
  readonly: true,
})

beforeEach(() => {
  backend.id = null
  localStorage.clear()
  store.getState().reset()
})

describe("side question panel", () => {
  it("keeps each main conversation's selection without dropping another question", () => {
    store.getState().open(question(11))
    store.getState().open(question(22, 2))
    expect(store.getState().selectedByParent).toEqual({ 1: 11, 2: 22 })
    expect(Object.keys(store.getState().opened)).toEqual(["11", "22"])
  })

  it("consumes an initial send once without touching another question", () => {
    const initialSend = {
      token: "unsent",
      draft: { blocks: [], displayText: "unsent-question" },
      modeId: null,
    }
    store.getState().open({ ...question(11), initialSend })
    store.getState().open(question(22, 2))
    store.getState().consumeInitialSend(11, initialSend.token)
    expect(store.getState().opened[11].initialSend).toBeNull()
    expect(store.getState().selectedByParent[2]).toBe(22)
    store.getState().open(question(11))
    expect(store.getState().opened[11].initialSend).toBeNull()
  })

  it("accepts a fresh first send after history opened the same question", () => {
    const first = {
      token: "first",
      draft: { blocks: [], displayText: "first attempt" },
      modeId: null,
    }
    const next = { ...first, token: "next" }
    store.getState().open(question(11))
    store.getState().open({ ...question(11), initialSend: first })
    expect(store.getState().opened[11].initialSend).toEqual(first)
    store.getState().open({ ...question(11), initialSend: next })
    store.getState().open(question(11))
    store.getState().consumeInitialSend(11, first.token)
    expect(store.getState().opened[11].initialSend).toEqual(next)
    store.getState().consumeInitialSend(11, next.token)
    expect(store.getState().opened[11].initialSend).toBeNull()
    store.getState().open({ ...question(11), initialSend: next })
    expect(store.getState().opened[11].initialSend).toBeNull()
  })

  it("restores only selected ids, never replays a pending prompt after restart", () => {
    store.getState().open({
      ...question(11),
      initialSend: {
        token: "restart",
        draft: { blocks: [], displayText: "unsent-question" },
        modeId: null,
      },
    })
    expect(
      localStorage.getItem("workspace:side-question-selection:local")
    ).toBe('{"1":11}')
    store.getState().reset()
    store.getState().hydrate()
    expect(store.getState().selectedByParent[1]).toBe(11)
    expect(store.getState().opened).toEqual({})
  })

  it("removes only the deleted question and its selection", () => {
    store.getState().open(question(11))
    store.getState().open(question(22, 2))
    store.getState().forget(11)
    expect(store.getState().opened[11]).toBeUndefined()
    expect(store.getState().selectedByParent).toEqual({ 2: 22 })
  })

  it("isolates persisted selection between local and remote backends", () => {
    store.getState().open(question(11))
    backend.id = 8
    store.getState().reset()
    store.getState().hydrate()
    expect(store.getState().selectedByParent).toEqual({})
    store.getState().open(question(22))
    backend.id = null
    store.getState().reset()
    store.getState().hydrate()
    expect(store.getState().selectedByParent).toEqual({ 1: 11 })
  })

  it("ignores corrupt persisted selections", () => {
    localStorage.setItem(
      "workspace:side-question-selection:local",
      JSON.stringify({
        1: "wrong",
        2: -1,
        3: 33,
        bad: 44,
      })
    )
    store.getState().hydrate()
    expect(store.getState().selectedByParent).toEqual({ 3: 33 })
  })
})
