import { StrictMode } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import arMessages from "@/i18n/messages/ar.json"
import deMessages from "@/i18n/messages/de.json"
import esMessages from "@/i18n/messages/es.json"
import frMessages from "@/i18n/messages/fr.json"
import jaMessages from "@/i18n/messages/ja.json"
import koMessages from "@/i18n/messages/ko.json"
import ptMessages from "@/i18n/messages/pt.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import twMessages from "@/i18n/messages/zh-TW.json"
import type {
  FileCheckpointPlan,
  FileCheckpointResponse,
} from "@/lib/file-checkpoint"
import {
  FileCheckpointPanel,
  type FileCheckpointPanelProps,
} from "./file-checkpoint-panel"

const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({
  getTransport: () => transport,
  getActiveRemoteConnectionId: () => null,
}))

const messages = enMessages.FileCheckpoint
const restorePlan: FileCheckpointPlan = {
  id: "preview-1",
  checkpointId: "snapshot-1",
  entries: [
    {
      path: "create.txt",
      change: "added",
      beforeText: null,
      afterText: "restored content",
      binary: false,
    },
    {
      path: "modify.ts",
      change: "modified",
      beforeText: "current content",
      afterText: "target content",
      binary: false,
    },
    {
      path: "delete.txt",
      change: "deleted",
      beforeText: "remove this",
      afterText: null,
      binary: false,
    },
    {
      path: "asset.png",
      change: "modified",
      beforeText: null,
      afterText: null,
      binary: true,
    },
  ],
}

function response(
  overrides: Partial<FileCheckpointResponse> = {}
): FileCheckpointResponse {
  return {
    enabled: true,
    root: "F:\\shared-workspace",
    checkpoints: [
      {
        id: "snapshot-1",
        label: "Other branch baseline",
        createdAt: "2026-11-10T08:00:00Z",
        conversationId: 20,
        fileCount: 4,
        bytes: 256,
      },
    ],
    lastRestoreId: "restore-previous",
    ...overrides,
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function view(overrides: Partial<FileCheckpointPanelProps> = {}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FileCheckpointPanel
        conversationId={10}
        isViewer={false}
        busy={false}
        {...overrides}
      />
    </NextIntlClientProvider>
  )
}

async function openPanel() {
  await userEvent.click(screen.getByRole("button", { name: messages.title }))
  await waitFor(() =>
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false")
  )
}

async function preview() {
  await userEvent.click(screen.getByRole("button", { name: messages.preview }))
  await screen.findByRole("region", { name: messages.previewTitle })
}

function expectOperation(operation: Record<string, unknown>) {
  expect(transport.call).toHaveBeenLastCalledWith(
    "file_checkpoint",
    { request: { conversationId: 10, ...operation } },
    { timeoutMs: 120_000 }
  )
}

beforeEach(() => {
  transport.call.mockReset()
  transport.call.mockImplementation(async (_command, { request }) =>
    response(
      request.action === "preview" || request.action === "undo"
        ? { plan: restorePlan }
        : {}
    )
  )
})
afterEach(cleanup)

describe("FileCheckpointPanel", () => {
  it.each([null, 0, -1, 1.5])(
    "hides the action for non-persisted ID %s",
    (conversationId) => {
      render(view({ conversationId }))
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
      expect(transport.call).not.toHaveBeenCalled()
    }
  )

  it("hides the action for viewers and disables it while the conversation is busy", () => {
    const rendered = render(view({ isViewer: true }))
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    rendered.rerender(view({ busy: true }))
    expect(screen.getByRole("button")).toBeDisabled()
    fireEvent.click(screen.getByRole("button"))
    expect(transport.call).not.toHaveBeenCalled()
  })

  it("loads only on opening and shows root-shared snapshots plus honest recovery boundaries", async () => {
    render(view())
    expect(transport.call).not.toHaveBeenCalled()
    await openPanel()
    expectOperation({ action: "list" })
    expect(screen.getByText("Other branch baseline")).toBeInTheDocument()
    expect(
      screen.getByText(/Conversation 20 · 4 files · 256 bytes/)
    ).toBeInTheDocument()
    expect(screen.getByText("F:\\shared-workspace")).toBeInTheDocument()
    for (const key of [
      "description",
      "fromNow",
      "excluded",
      "sharedDirectory",
      "limits",
    ] as const)
      expect(screen.getByText(messages[key])).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: messages.close }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: messages.title })).toHaveFocus()
    await openPanel()
    expect(transport.call).toHaveBeenCalledTimes(2)
  })

  it("previews default-all selection with current/target direction and never auto-applies", async () => {
    render(view())
    await openPanel()
    await preview()
    expectOperation({ action: "preview", checkpointId: "snapshot-1" })
    expect(screen.getAllByRole("checkbox")).toHaveLength(5)
    screen
      .getAllByRole("checkbox")
      .forEach((checkbox) => expect(checkbox).toBeChecked())
    const currentColumn = screen.getAllByText(messages.current)[1]
      .parentElement!
    const targetColumn = screen.getAllByText(messages.target)[1].parentElement!
    expect(
      within(currentColumn).getByText("current content")
    ).toBeInTheDocument()
    expect(
      within(currentColumn).queryByText("target content")
    ).not.toBeInTheDocument()
    expect(within(targetColumn).getByText("target content")).toBeInTheDocument()
    expect(screen.getByText(messages.binary)).toBeInTheDocument()
    expect(
      screen.getByText("Selected: create 1, overwrite 2, delete 1.")
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: messages.apply })
    ).not.toBeInTheDocument()
    expect(transport.call).toHaveBeenCalledTimes(2)
  })

  it("requires explicit counts confirmation and sends only selected paths with the preview plan ID", async () => {
    render(view())
    await openPanel()
    await preview()
    await userEvent.click(screen.getByRole("checkbox", { name: "asset.png" }))
    expect(
      screen.getByText("Selected: create 1, overwrite 1, delete 1.")
    ).toBeInTheDocument()
    expect(transport.call).toHaveBeenCalledTimes(2)
    await userEvent.click(
      screen.getByRole("button", { name: messages.reviewRestore })
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "create 1, overwrite 1, and delete 1 files"
    )
    await userEvent.click(screen.getByRole("button", { name: messages.cancel }))
    expect(transport.call).toHaveBeenCalledTimes(2)
    await userEvent.click(
      screen.getByRole("button", { name: messages.reviewRestore })
    )
    await userEvent.click(screen.getByRole("button", { name: messages.apply }))
    await screen.findByText(messages.completed)
    expectOperation({
      action: "apply",
      planId: "preview-1",
      paths: ["create.txt", "modify.ts", "delete.txt"],
    })
    expect(
      screen.queryByRole("region", { name: messages.previewTitle })
    ).not.toBeInTheDocument()
  })

  it("disables apply for empty selection and resets confirmation when selection changes", async () => {
    render(view())
    await openPanel()
    await preview()
    await userEvent.click(
      screen.getByRole("checkbox", { name: messages.selectAll })
    )
    expect(
      screen.getByRole("button", { name: messages.reviewRestore })
    ).toBeDisabled()
    await userEvent.click(screen.getByRole("checkbox", { name: "modify.ts" }))
    await userEvent.click(
      screen.getByRole("button", { name: messages.reviewRestore })
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "create 0, overwrite 1, and delete 0 files"
    )
    await userEvent.click(screen.getByRole("checkbox", { name: "create.txt" }))
    expect(
      screen.queryByRole("button", { name: messages.apply })
    ).not.toBeInTheDocument()
    expect(transport.call).toHaveBeenCalledTimes(2)
  })

  it("previews undo using lastRestoreId and requires the same selected-file confirmation", async () => {
    const inversePlan: FileCheckpointPlan = {
      ...restorePlan,
      id: "inverse-plan",
      entries: [
        {
          path: "create.txt",
          change: "deleted",
          beforeText: "restored content",
          afterText: null,
          binary: false,
        },
      ],
    }
    transport.call
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ plan: inversePlan }))
    render(view())
    await openPanel()
    await userEvent.click(screen.getByRole("button", { name: messages.undo }))
    await screen.findByRole("region", { name: messages.previewTitle })
    expectOperation({ action: "undo", planId: "restore-previous" })
    expect(transport.call).toHaveBeenCalledTimes(2)
    await userEvent.click(
      screen.getByRole("button", { name: messages.reviewRestore })
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "create 0, overwrite 0, and delete 1 files"
    )
    await userEvent.click(screen.getByRole("button", { name: messages.apply }))
    await screen.findByText(messages.completed)
    expectOperation({
      action: "apply",
      planId: "inverse-plan",
      paths: ["create.txt"],
    })
  })

  it("locks dismissal, duplicate writes, navigation, global shortcuts and drops until a write settles", async () => {
    const pending = deferred<FileCheckpointResponse>()
    render(view())
    await openPanel()
    transport.call.mockReturnValueOnce(pending.promise)
    const capture = screen.getByRole("button", { name: messages.capture })
    fireEvent.click(capture)
    fireEvent.click(capture)
    expectOperation({ action: "capture" })
    expect(transport.call).toHaveBeenCalledTimes(2)
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true")
    screen
      .getAllByRole("button")
      .forEach((button) => expect(button).toBeDisabled())
    const shortcut = vi.fn()
    window.addEventListener("keydown", shortcut)
    try {
      expect(fireEvent.keyDown(window, { key: "w", ctrlKey: true })).toBe(false)
      expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(false)
      expect(shortcut).not.toHaveBeenCalled()
      expect(fireEvent.click(document.body)).toBe(false)
      expect(fireEvent.drop(document.body)).toBe(false)
      fireEvent.click(screen.getByRole("button", { name: messages.close }))
      expect(screen.getByRole("dialog")).toBeInTheDocument()
      await act(async () => pending.resolve(response()))
      expect(fireEvent.keyDown(window, { key: "w", ctrlKey: true })).toBe(true)
      expect(shortcut).toHaveBeenCalledTimes(1)
      expect(fireEvent.drop(document.body)).toBe(true)
      await userEvent.click(
        screen.getByRole("button", { name: messages.close })
      )
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    } finally {
      window.removeEventListener("keydown", shortcut)
    }
  })

  it("discards a failed apply plan, offers actionable refresh and never retries the write", async () => {
    render(view())
    await openPanel()
    await preview()
    await userEvent.click(
      screen.getByRole("button", { name: messages.reviewRestore })
    )
    transport.call.mockRejectedValueOnce(
      new Error("Workspace changed; preview again")
    )
    await userEvent.click(screen.getByRole("button", { name: messages.apply }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace changed; preview again"
    )
    expect(screen.getByRole("alert")).toHaveTextContent(messages.errorHelp)
    expect(
      screen.queryByRole("region", { name: messages.previewTitle })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: messages.apply })
    ).not.toBeInTheDocument()
    expect(transport.call).toHaveBeenCalledTimes(3)
    await userEvent.click(
      screen.getByRole("button", { name: messages.refresh })
    )
    await screen.findByText("Other branch baseline")
    expectOperation({ action: "list" })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("invalidates an existing plan on refresh, including a failed refresh", async () => {
    render(view())
    await openPanel()
    await preview()
    transport.call.mockRejectedValueOnce(new Error("Directory is unavailable"))
    await userEvent.click(
      screen.getByRole("button", { name: messages.refresh })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Directory is unavailable"
    )
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: messages.capture })
    ).toBeDisabled()
    await userEvent.click(
      screen.getByRole("button", { name: messages.refresh })
    )
    await screen.findByText("Other branch baseline")
    expect(screen.getByRole("button", { name: messages.capture })).toBeEnabled()
  })

  it("handles missing preview plans and empty plans without making apply possible", async () => {
    transport.call
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response())
    render(view())
    await openPanel()
    await userEvent.click(
      screen.getByRole("button", { name: messages.preview })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      messages.missingPlan
    )
    await userEvent.click(
      screen.getByRole("button", { name: messages.refresh })
    )
    await screen.findByText("Other branch baseline")
    transport.call.mockResolvedValueOnce(
      response({ plan: { ...restorePlan, entries: [] } })
    )
    await preview()
    expect(screen.getByText(messages.noChanges)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: messages.reviewRestore })
    ).toBeDisabled()
  })

  it("confirms metadata-only deletion and never applies a file plan", async () => {
    render(view())
    await openPanel()
    await preview()
    await userEvent.click(screen.getByRole("button", { name: messages.delete }))
    expect(screen.getByRole("alert")).toHaveTextContent(messages.deleteHelp)
    expect(
      screen.queryByRole("region", { name: messages.previewTitle })
    ).not.toBeInTheDocument()
    expect(transport.call).toHaveBeenCalledTimes(2)
    transport.call.mockResolvedValueOnce(response({ checkpoints: [] }))
    await userEvent.click(
      screen.getByRole("button", { name: messages.deleteSnapshot })
    )
    await screen.findByText(messages.empty)
    expectOperation({ action: "delete", checkpointId: "snapshot-1" })
  })

  it("uses server state for enable/disable, permits manual capture without automation and disables unavailable undo", async () => {
    transport.call.mockResolvedValueOnce(
      response({ enabled: false, checkpoints: [], lastRestoreId: null })
    )
    render(view())
    await openPanel()
    expect(screen.getByRole("button", { name: messages.undo })).toBeDisabled()
    await userEvent.click(
      screen.getByRole("button", { name: messages.capture })
    )
    await screen.findByText(messages.completed)
    expectOperation({ action: "capture" })
    transport.call.mockResolvedValueOnce(response({ enabled: false }))
    await userEvent.click(
      screen.getByRole("button", { name: messages.disable })
    )
    await screen.findByText(messages.disabled)
    expectOperation({ action: "disable" })
    await userEvent.click(screen.getByRole("button", { name: messages.enable }))
    await screen.findByText(messages.enabled)
    expectOperation({ action: "enable" })
  })

  it("disables every operation when the conversation becomes busy with a preview open", async () => {
    const rendered = render(view())
    await openPanel()
    await preview()
    rendered.rerender(view({ busy: true }))
    expect(screen.getByText(messages.waitForCompletion)).toBeInTheDocument()
    for (const button of screen.getAllByRole("button")) {
      if (button.getAttribute("aria-label") !== messages.close)
        expect(button).toBeDisabled()
    }
    screen
      .getAllByRole("checkbox")
      .forEach((checkbox) => expect(checkbox).toBeDisabled())
    expect(transport.call).toHaveBeenCalledTimes(2)
  })

  it("isolates late responses across conversation changes and releases the interaction lock", async () => {
    const pending = deferred<FileCheckpointResponse>()
    const rendered = render(view())
    await openPanel()
    transport.call.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole("button", { name: messages.preview }))
    rendered.rerender(view({ conversationId: 30 }))
    expect(fireEvent.keyDown(window, { key: "t", ctrlKey: true })).toBe(true)
    await act(async () => pending.resolve(response({ plan: restorePlan })))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await openPanel()
    expect(transport.call).toHaveBeenLastCalledWith(
      "file_checkpoint",
      { request: { conversationId: 30, action: "list" } },
      { timeoutMs: 120_000 }
    )
    expect(
      screen.queryByRole("region", { name: messages.previewTitle })
    ).not.toBeInTheDocument()
  })

  it("renders file content as text and never submits its parent form, including under StrictMode", async () => {
    const submit = vi.fn((event) => event.preventDefault())
    transport.call.mockResolvedValueOnce(response()).mockResolvedValueOnce(
      response({
        plan: {
          ...restorePlan,
          entries: [
            {
              ...restorePlan.entries[0],
              afterText: "<script>window.danger = true</script>",
            },
          ],
        },
      })
    )
    render(
      <StrictMode>
        <form onSubmit={submit}>{view()}</form>
      </StrictMode>
    )
    await openPanel()
    await preview()
    expect(
      screen.getByText("<script>window.danger = true</script>")
    ).toBeInTheDocument()
    expect(screen.getByRole("dialog").querySelector("script")).toBeNull()
    screen
      .getAllByRole("button")
      .forEach((button) => expect(button).toHaveAttribute("type", "button"))
    expect(submit).not.toHaveBeenCalled()
  })
})

describe("file checkpoint translations", () => {
  it.each([
    ["ar", arMessages],
    ["de", deMessages],
    ["es", esMessages],
    ["fr", frMessages],
    ["ja", jaMessages],
    ["ko", koMessages],
    ["pt", ptMessages],
    ["zh-CN", zhMessages],
    ["zh-TW", twMessages],
  ] as const)(
    "has complete keys and consistent interpolation in %s",
    (_locale, localized) => {
      expect(Object.keys(localized.FileCheckpoint).sort()).toEqual(
        Object.keys(messages).sort()
      )
      for (const key of Object.keys(messages) as (keyof typeof messages)[]) {
        const text = localized.FileCheckpoint[key]
        expect(text.trim()).not.toBe("")
        expect(text.match(/\{\w+\}/g)?.sort() ?? []).toEqual(
          messages[key].match(/\{\w+\}/g)?.sort() ?? []
        )
      }
    }
  )
})
