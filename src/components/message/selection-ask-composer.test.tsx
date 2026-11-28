import { act, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { PromptDraft } from "@/lib/types"
import { loadSideQuestionDraft } from "@/lib/side-question-draft"
import { toast } from "sonner"
import {
  buildAskComposerText,
  SelectionAskComposer,
} from "./selection-ask-composer"

const capability = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({ getReadonlyAskCapability: capability }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
vi.mock("@/lib/transport", () => ({ getActiveRemoteConnectionId: () => null }))
let inputProps: Record<string, unknown> = {}
vi.mock("@/components/chat/message-input", () => ({
  MessageInput: (props: Record<string, unknown>) => {
    inputProps = props
    return <div />
  },
}))
const draft: PromptDraft = {
  blocks: [
    { type: "text", text: "why?" },
    { type: "image", data: "aW1hZ2U=", mime_type: "image/png" },
  ],
  displayText: "why?",
}
type Submit = React.ComponentProps<typeof SelectionAskComposer>["onSubmit"]

function renderComposer(onSubmit = vi.fn<Submit>().mockResolvedValue(true)) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SelectionAskComposer
        selection="some text"
        mention={{ conversationId: 7, label: "Main" }}
        defaultAgentType="claude_code"
        defaultPath="/repo"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    </NextIntlClientProvider>
  )
  return { ...view, submit: onSubmit }
}
async function send() {
  const onSend = inputProps.onSend as (d: PromptDraft) => unknown
  await act(async () => {
    onSend(draft)
  })
}
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  capability.mockReset()
  capability.mockResolvedValue({ supported: true })
  inputProps = {}
})

describe("SelectionAskComposer", () => {
  it("waits for safe capability and does not offer writable settings or commands", async () => {
    const { submit } = renderComposer()
    expect(inputProps.disabled).toBe(true)
    await send()
    expect(submit).not.toHaveBeenCalled()
    await waitFor(() => expect(inputProps.disabled).toBe(false))
    expect(inputProps.agentType).toBe("claude_code")
    expect(inputProps.modes).toEqual([])
    expect(inputProps.configOptions).toEqual([])
    expect(inputProps.availableCommands).toEqual([])
    await send()
    expect(submit).toHaveBeenCalledWith(
      draft,
      expect.any(String),
      expect.any(String),
      null
    )
  })

  it("fails closed if capability cannot be verified", async () => {
    capability.mockRejectedValue(new Error("offline"))
    const { submit } = renderComposer()
    await act(async () => {})
    await send()
    expect(inputProps.disabled).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it("returns a failed draft and retries the same creation request", async () => {
    const submit = vi.fn<Submit>().mockResolvedValue(false)
    renderComposer(submit)
    await waitFor(() => expect(inputProps.disabled).toBe(false))
    await send()
    expect(inputProps.injectContent).toEqual({ handBack: draft.blocks })
    expect(loadSideQuestionDraft(null, "source", 7)?.draft).toEqual(draft)
    await send()
    expect(submit.mock.calls[0]?.[1]).toBe(submit.mock.calls[1]?.[1])
  })

  it("suppresses a duplicate send while creation is pending", async () => {
    let resolve!: (value: boolean) => void
    const submit = vi.fn<Submit>(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        })
    )
    renderComposer(submit)
    await waitFor(() => expect(inputProps.disabled).toBe(false))
    await send()
    await send()
    expect(submit).toHaveBeenCalledTimes(1)
    await act(async () => resolve(true))
  })

  it("restores the pending first question with its attachment after refresh, without submitting", async () => {
    let resolve!: (value: boolean) => void
    const first = renderComposer(
      vi.fn<Submit>(
        () =>
          new Promise<boolean>((done) => {
            resolve = done
          })
      )
    )
    await waitFor(() => expect(inputProps.disabled).toBe(false))
    await send()
    const saved = loadSideQuestionDraft(null, "source", 7)
    expect(saved?.draft).toEqual(draft)
    first.unmount()

    const { submit } = renderComposer()
    await waitFor(() => expect(inputProps.disabled).toBe(false))
    expect(inputProps.injectContent).toEqual({ handBack: draft.blocks })
    expect(submit).not.toHaveBeenCalled()
    await send()
    expect(submit).toHaveBeenCalledWith(
      draft,
      saved?.requestId,
      expect.any(String),
      null
    )
    await act(async () => resolve(false))
  })

  it("keeps the composer intact if preflight storage is unavailable", async () => {
    const { submit } = renderComposer()
    await waitFor(() => expect(inputProps.disabled).toBe(false))
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError")
      })
    try {
      expect((inputProps.onSend as (d: PromptDraft) => unknown)(draft)).toBe(
        false
      )
      expect(submit).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith(
        enMessages.Folder.sideQuestion.draftSaveFailed
      )
    } finally {
      storage.mockRestore()
    }
  })
})

describe("buildAskComposerText", () => {
  it("keeps selected text without adding a reference that reads the live main thread", () => {
    expect(buildAskComposerText("first\nsecond")).toBe("> first\n> second\n\n")
    expect(buildAskComposerText(" \n ")).toBe("")
  })
})
