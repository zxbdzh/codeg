import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"

const scene = vi.hoisted(() => ({
  parentId: 1,
  remote: null as string | null,
  rows: [] as Array<Record<string, unknown>>,
  capability: vi.fn(),
  create: vi.fn(),
  retry: vi.fn(),
}))
vi.mock("@/hooks/use-side-question-source", () => ({
  useSideQuestionSource: () => ({ parentId: scene.parentId }),
}))
vi.mock("@/hooks/use-ask-conversations", () => ({
  useLinkedConversationsState: () => ({
    rows: scene.rows,
    error: null,
    retry: scene.retry,
  }),
}))
vi.mock("@/lib/api", () => ({
  getReadonlyAskCapability: scene.capability,
  createReadonlyAskConversation: scene.create,
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => scene.remote,
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (value: unknown) => unknown) =>
    selector({ allFolders: [{ id: 1, path: "/tmp" }] }),
}))
vi.mock("@/components/conversations/side-question-host", () => ({
  SideQuestionDock: () => <div data-testid="dock" />,
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value: string
    onValueChange: (value: string) => void
  }) => (
    <select
      aria-label="Select a side question"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => children,
  SelectValue: () => <option value="">Select</option>,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode
    value: string
  }) => <option value={value}>{children}</option>,
}))
import { useSideQuestionPanelStore } from "@/stores/side-question-panel-store"
import { SideQuestionTab } from "./aux-panel-side-question-tab"

function view() {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <SideQuestionTab />
    </NextIntlClientProvider>
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const row = (id: number, readonly: boolean) => ({
  id,
  title: `Question ${id}`,
  folder_id: 1,
  agent_type: "claude_code",
  readonly_ask: readonly,
})

describe("SideQuestionTab", () => {
  beforeEach(() => {
    localStorage.clear()
    useSideQuestionPanelStore.getState().reset()
    scene.remote = null
    scene.parentId = 1
    scene.rows = []
    scene.capability.mockReset()
    scene.create.mockReset()
    scene.retry.mockReset()
  })
  it("ignores a creation result from a previous backend", async () => {
    const creation = deferred<{
      conversationId: number
      parentConversationId: number
      folderId: number
      agentType: string
    }>()
    scene.capability.mockResolvedValue({ supported: true })
    scene.create.mockReturnValue(creation.promise)
    render(view())
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "New side question" })
      ).toBeEnabled()
    )
    fireEvent.click(screen.getByRole("button", { name: "New side question" }))
    scene.remote = "remote-b"
    act(() => useSideQuestionPanelStore.getState().reset())
    await act(async () =>
      creation.resolve({
        conversationId: 10,
        parentConversationId: 1,
        folderId: 1,
        agentType: "claude_code",
      })
    )
    expect(useSideQuestionPanelStore.getState().opened).toEqual({})
    expect(useSideQuestionPanelStore.getState().selectedByParent).toEqual({})
    expect(scene.retry).not.toHaveBeenCalled()
  })
  it("fails closed on capability errors and shows unsupported reasons", async () => {
    scene.capability.mockRejectedValueOnce(new Error("offline"))
    render(view())
    expect(
      screen.getByRole("button", { name: "New side question" })
    ).toBeDisabled()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load side questions"
    )
    scene.capability.mockResolvedValueOnce({
      supported: false,
      reason: "unsupportedAgent",
    })
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(
      await screen.findByText(messages.Folder.sideQuestion.unsupportedAgent)
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: "New side question" })
    ).toBeDisabled()
    expect(scene.create).not.toHaveBeenCalled()
  })
  it("restores a selected historical record and preserves its original permission", async () => {
    localStorage.setItem(
      "workspace:side-question-selection:local",
      JSON.stringify({ 1: 10 })
    )
    act(() => useSideQuestionPanelStore.getState().hydrate())
    scene.rows = [row(10, false), row(11, true)]
    scene.capability.mockResolvedValue({ supported: true })
    render(view())
    expect(
      await screen.findByText(messages.Folder.sideQuestion.legacyHint)
    ).toBeVisible()
    expect(useSideQuestionPanelStore.getState().opened[10].readonly).toBe(false)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "11" } })
    expect(
      screen.getByText(messages.Folder.sideQuestion.readonlyHint)
    ).toBeVisible()
    expect(useSideQuestionPanelStore.getState().opened[11].readonly).toBe(true)
  })
  it("keeps late capability and creation results assigned to their original source", async () => {
    const oldCapability = deferred<{ supported: boolean }>()
    scene.capability
      .mockReturnValueOnce(oldCapability.promise)
      .mockResolvedValue({ supported: true })
    const creation = deferred<{
      conversationId: number
      parentConversationId: number
      folderId: number
      agentType: string
    }>()
    scene.create.mockReturnValue(creation.promise)
    const { rerender } = render(view())
    scene.parentId = 2
    rerender(view())
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "New side question" })
      ).toBeEnabled()
    )
    await act(async () => oldCapability.resolve({ supported: false }))
    expect(
      screen.getByRole("button", { name: "New side question" })
    ).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "New side question" }))
    scene.parentId = 3
    rerender(view())
    await act(async () =>
      creation.resolve({
        conversationId: 20,
        parentConversationId: 2,
        folderId: 1,
        agentType: "claude_code",
      })
    )
    expect(useSideQuestionPanelStore.getState().selectedByParent[2]).toBe(20)
    expect(
      useSideQuestionPanelStore.getState().selectedByParent[3]
    ).toBeUndefined()
  })
})
