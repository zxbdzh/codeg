import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  SideQuestionAnswer,
  SideQuestionSource,
} from "@/lib/side-question"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  otherCall: vi.fn(),
  current: "first",
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: mocks.current === "first" ? mocks.call : mocks.otherCall,
  }),
}))

import {
  resetSideQuestions,
  sideQuestionSourceKey,
  useSideQuestionStore,
} from "./side-question-store"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const answer = (text: string): SideQuestionAnswer => ({
  answer: text,
  agentType: "claude_code",
  contextMessages: 1,
  contextChars: 7,
  selectionChars: 0,
})

const source: SideQuestionSource = {
  sourceConnectionId: "source-connection",
  sourceConversationId: 12,
  sourceAgentType: "codex",
}

describe("side question isolation", () => {
  beforeEach(() => {
    resetSideQuestions()
    mocks.call.mockReset()
    mocks.otherCall.mockReset()
    mocks.current = "first"
    mocks.call.mockResolvedValue(undefined)
    mocks.otherCall.mockResolvedValue(undefined)
  })

  it("keeps each source draft and selection separate", () => {
    const actions = useSideQuestionStore.getState()
    actions.setQuestion("first", "first question")
    actions.setQuestion("second", "second question")
    actions.setSelection("first", "chosen passage")
    expect(useSideQuestionStore.getState().bySource.second.question).toBe(
      "second question"
    )
    expect(useSideQuestionStore.getState().bySource.first.selection).toBe(
      "chosen passage"
    )
    expect(
      sideQuestionSourceKey({ id: "tab-1", folderId: 2, agentType: "codex" })
    ).toBe("tab-1:2:codex")
  })

  it("sends attachment-only questions and keeps a separate immutable sent snapshot", async () => {
    const waiting = deferred<SideQuestionAnswer>()
    mocks.call.mockReturnValue(waiting.promise)
    const actions = useSideQuestionStore.getState()
    const image = {
      id: "shot",
      bytes: 3,
      type: "image" as const,
      name: "shot.png",
      mimeType: "image/png",
      data: "bytes",
    }
    actions.addAttachments("first", [image])
    expect(
      useSideQuestionStore.getState().bySource.second?.attachments
    ).toBeUndefined()
    const asking = actions.ask("first", [], source)
    actions.removeAttachment("first", "shot")
    expect(
      useSideQuestionStore.getState().bySource.first.askedAttachments
    ).toEqual([image])
    expect(mocks.call).toHaveBeenCalledWith(
      "side_question_ask",
      expect.objectContaining({
        question: "",
        attachments: [
          {
            type: "image",
            name: "shot.png",
            mimeType: "image/png",
            data: "bytes",
          },
        ],
      }),
      expect.anything()
    )
    waiting.resolve(answer("image answer"))
    await asking
    actions.clear("first")
    expect(useSideQuestionStore.getState().bySource.first.attachments).toEqual(
      []
    )
    expect(
      useSideQuestionStore.getState().bySource.first.askedAttachments
    ).toEqual([])
  })

  it("sends an immutable independent request with a long generation timeout", async () => {
    mocks.call.mockResolvedValue(answer("done"))
    const actions = useSideQuestionStore.getState()
    actions.setQuestion("first", " question ")
    await actions.ask("first", [{ role: "user", text: "context" }], source)
    expect(mocks.call).toHaveBeenCalledWith(
      "side_question_ask",
      {
        requestId: expect.any(String),
        question: "question",
        selection: null,
        context: [{ role: "user", text: "context" }],
        ...source,
      },
      { timeoutMs: 30 * 60_000 }
    )
    expect(useSideQuestionStore.getState().bySource.first.result?.answer).toBe(
      "done"
    )
  })

  it("sends only the selection when one is present", async () => {
    mocks.call.mockResolvedValue(answer("selection answer"))
    const actions = useSideQuestionStore.getState()
    actions.setSelection("first", "selected")
    actions.setQuestion("first", "why?")
    await actions.ask("first", [{ role: "user", text: "not sent" }], source)
    expect(mocks.call).toHaveBeenCalledWith(
      "side_question_ask",
      expect.objectContaining({ selection: "selected", context: [] }),
      expect.anything()
    )
  })

  it("keeps source identity separate for concurrently pending questions", async () => {
    const firstAnswer = deferred<SideQuestionAnswer>()
    const secondAnswer = deferred<SideQuestionAnswer>()
    mocks.call
      .mockReturnValueOnce(firstAnswer.promise)
      .mockReturnValueOnce(secondAnswer.promise)
    const actions = useSideQuestionStore.getState()
    actions.setQuestion("first", "first source")
    actions.setQuestion("second", "second source")
    const first = actions.ask("first", [], source)
    const secondSource: SideQuestionSource = {
      sourceConnectionId: "claude-connection",
      sourceConversationId: null,
      sourceAgentType: "claude_code",
    }
    const second = actions.ask("second", [], secondSource)
    expect(mocks.call.mock.calls[0][1]).toMatchObject(source)
    expect(mocks.call.mock.calls[1][1]).toMatchObject(secondSource)
    secondAnswer.resolve(answer("second answer"))
    await second
    firstAnswer.resolve(answer("first answer"))
    await first
    expect(useSideQuestionStore.getState().bySource.first.result?.answer).toBe(
      "first answer"
    )
    expect(useSideQuestionStore.getState().bySource.second.result?.answer).toBe(
      "second answer"
    )
  })

  it("ignores duplicate submits and never replaces another source's answer", async () => {
    const pending = deferred<SideQuestionAnswer>()
    mocks.call.mockReturnValue(pending.promise)
    const actions = useSideQuestionStore.getState()
    actions.setQuestion("first", "first")
    const request = actions.ask("first", [], source)
    await actions.ask("first", [], source)
    actions.setQuestion("second", "second")
    expect(mocks.call).toHaveBeenCalledTimes(1)
    pending.resolve(answer("first answer"))
    await request
    expect(useSideQuestionStore.getState().bySource.second.result).toBeNull()
    expect(useSideQuestionStore.getState().bySource.first.result?.answer).toBe(
      "first answer"
    )
  })

  it("ignores a cancelled late answer and keeps a subsequent request", async () => {
    const old = deferred<SideQuestionAnswer>()
    const next = deferred<SideQuestionAnswer>()
    let asks = 0
    mocks.call.mockImplementation((command: string) => {
      if (command === "side_question_cancel") return Promise.resolve()
      asks += 1
      return asks === 1 ? old.promise : next.promise
    })
    const actions = useSideQuestionStore.getState()
    actions.setQuestion("first", "old question")
    const first = actions.ask("first", [], source)
    actions.cancel("first")
    actions.setQuestion("first", "new question")
    const second = actions.ask("first", [], {
      ...source,
      sourceConnectionId: "replacement-connection",
    })
    expect(mocks.call).toHaveBeenLastCalledWith(
      "side_question_ask",
      expect.objectContaining({ sourceConnectionId: "replacement-connection" }),
      expect.anything()
    )
    old.resolve(answer("stale answer"))
    await first
    expect(useSideQuestionStore.getState().bySource.first.status).toBe(
      "loading"
    )
    expect(useSideQuestionStore.getState().bySource.first.result).toBeNull()
    next.resolve(answer("new answer"))
    await second
    expect(useSideQuestionStore.getState().bySource.first.result?.answer).toBe(
      "new answer"
    )
  })

  it("cancels through the transport that owns the request when the backend changes", async () => {
    const waiting = deferred<SideQuestionAnswer>()
    mocks.call.mockImplementation((command: string) =>
      command === "side_question_ask" ? waiting.promise : Promise.resolve()
    )
    const actions = useSideQuestionStore.getState()
    actions.setQuestion("first", "question")
    const request = actions.ask("first", [], source)
    mocks.current = "other"
    resetSideQuestions()
    expect(mocks.call).toHaveBeenCalledWith("side_question_cancel", {
      requestId: expect.any(String),
    })
    expect(mocks.otherCall).not.toHaveBeenCalled()
    waiting.resolve(answer("late"))
    await request
    expect(useSideQuestionStore.getState().bySource).toEqual({})
  })

  it("surfaces an error without writing a result", async () => {
    mocks.call.mockRejectedValue({
      code: "task_execution_failed",
      message: "provider unavailable",
    })
    const actions = useSideQuestionStore.getState()
    actions.setQuestion("first", "question")
    await actions.ask("first", [], source)
    expect(useSideQuestionStore.getState().bySource.first.error).toBe(
      "provider unavailable"
    )
    expect(useSideQuestionStore.getState().bySource.first.status).toBe("error")
  })

  it("ignores a cancelled late failure instead of erasing the next answer", async () => {
    const old = deferred<SideQuestionAnswer>()
    mocks.call.mockImplementation((command: string) =>
      command === "side_question_cancel" ? Promise.resolve() : old.promise
    )
    const actions = useSideQuestionStore.getState()
    actions.setQuestion("first", "old question")
    const first = actions.ask("first", [], source)
    actions.cancel("first")
    mocks.call.mockResolvedValue(answer("new answer"))
    actions.setQuestion("first", "new question")
    await actions.ask("first", [], {
      ...source,
      sourceConnectionId: "new-connection",
    })
    old.reject(new Error("late failure"))
    await first
    expect(useSideQuestionStore.getState().bySource.first).toMatchObject({
      status: "done",
      result: { answer: "new answer" },
      error: null,
    })
  })
})
