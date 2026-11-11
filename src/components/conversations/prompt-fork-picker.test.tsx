import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { Dialog } from "@/components/ui/dialog"
import { PromptForkPicker } from "./prompt-fork-picker"

const api = vi.hoisted(() => ({ detail: vi.fn() }))
vi.mock("@/lib/api", () => ({ getFolderConversation: api.detail }))
const onSelect = vi.fn()
const turns = [
  {
    id: "turn-0",
    role: "user",
    timestamp: "2026-11-10T01:00:00Z",
    blocks: [{ type: "text", text: "Original question" }],
  },
  {
    id: "turn-1",
    role: "assistant",
    blocks: [{ type: "text", text: "Assistant private answer" }],
  },
  {
    id: "turn-2",
    role: "user",
    timestamp: "2026-11-10T01:01:00Z",
    blocks: [{ type: "text", text: "Try another approach" }],
  },
  {
    id: "turn-3",
    role: "assistant",
    blocks: [{ type: "text", text: "Later answer" }],
  },
  {
    id: "turn-4",
    role: "user",
    blocks: [
      { type: "text", text: "With attachment" },
      { type: "image", data: "x" },
    ],
  },
]

function view(unavailableReason?: string | null) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Dialog open>
        <PromptForkPicker
          conversationId={10}
          onSelect={onSelect}
          unavailableReason={unavailableReason}
        />
      </Dialog>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  api.detail.mockReset().mockResolvedValue({
    turns,
    summary: { agent_type: "claude_code" },
  })
  onSelect.mockReset().mockResolvedValue(true)
})
afterEach(cleanup)

describe("prompt fork picker", () => {
  it("loads all historical user messages and never lists assistant replies", async () => {
    render(view())
    expect(
      await screen.findByRole("button", { name: "Original question" })
    ).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Try another approach" })
    ).toBeEnabled()
    expect(
      screen.queryByText("Assistant private answer")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Later answer")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "With attachment" })
    ).toBeDisabled()
    expect(api.detail).toHaveBeenCalledWith(10)
  })

  it("chooses a middle prompt before that prompt and passes the exact draft", async () => {
    render(view())
    await userEvent.click(
      await screen.findByRole("button", { name: "Try another approach" })
    )
    expect(onSelect).toHaveBeenCalledWith(
      "turn-2",
      "Try another approach",
      false,
      {
        text: "Try another approach",
        timestamp: "2026-11-10T01:01:00Z",
        agentMessageId: null,
      }
    )
  })

  it("explains unavailable forks while keeping the first prompt usable as a new draft", async () => {
    render(view("Reconnect the conversation before forking"))
    expect(
      await screen.findByRole("button", { name: "Original question" })
    ).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Try another approach" })
    ).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reconnect the conversation before forking"
    )
  })

  it("disables a Codex boundary whose preceding assistant has only tool content", async () => {
    api.detail.mockResolvedValue({
      summary: { agent_type: "codex" },
      turns: [
        turns[0],
        { ...turns[1], blocks: [{ type: "thinking", text: "not an answer" }] },
        turns[2],
      ],
    })
    render(view())
    expect(
      await screen.findByRole("button", { name: "Try another approach" })
    ).toBeDisabled()
  })

  it("shows a fork failure inside the picker instead of closing it silently", async () => {
    onSelect.mockRejectedValue(new Error("Fork adapter exited"))
    render(view())
    await screen.findByRole("button", { name: "Original question" })
    await userEvent.click(
      screen.getByRole("button", { name: "Try another approach" })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Fork adapter exited"
    )
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("chooses the first prompt as a fresh draft and supports search", async () => {
    render(view())
    await screen.findByRole("button", { name: "Original question" })
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Original" },
    })
    expect(
      screen.queryByRole("button", { name: "Try another approach" })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: "Original question" })
    )
    expect(onSelect).toHaveBeenCalledWith("turn-0", "Original question", true, {
      text: "Original question",
      timestamp: "2026-11-10T01:00:00Z",
      agentMessageId: null,
    })
  })

  it("blocks duplicate selection and closing while a fork is pending", async () => {
    let complete!: (value: boolean) => void
    onSelect.mockReturnValue(
      new Promise<boolean>((resolve) => {
        complete = resolve
      })
    )
    render(view())
    const button = await screen.findByRole("button", {
      name: "Try another approach",
    })
    await userEvent.click(button)
    await userEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled()
    await act(async () => complete(false))
    expect(button).toBeEnabled()
  })

  it("keeps load errors retryable without showing stale history", async () => {
    api.detail.mockRejectedValueOnce(new Error("offline"))
    render(view())
    expect(await screen.findByRole("alert")).toHaveTextContent("offline")
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Original question" })
      ).toBeEnabled()
    )
    expect(api.detail).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["claude_code", "messageBoundary"],
    ["codex", "turnBoundary"],
    ["deepseek", "turnBoundary"],
  ] as const)(
    "explains the %s history boundary and shared files",
    async (agent, label) => {
      api.detail.mockResolvedValue({ turns, summary: { agent_type: agent } })
      render(view())
      await screen.findByRole("button", { name: "Original question" })
      expect(
        screen.getByText(
          (text) =>
            text.includes(enMessages.ResearchBranch[label]) &&
            text.includes(enMessages.ResearchBranch.sharedDirectory)
        )
      ).toBeInTheDocument()
    }
  )
})
