import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { SideQuestionSettings } from "@/lib/side-question"
import type { AgentOptionsSnapshot } from "@/lib/types"

const scene = vi.hoisted(() => ({
  call: vi.fn(),
  saved: { configValues: {} } as SideQuestionSettings,
  probeError: null as string | null,
  unapplied: [] as string[],
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: scene.call }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/automations/use-agent-options", () => ({
  useAgentOptions: () => ({
    snapshot: snapshot(),
    current: true,
    loading: false,
    error: scene.probeError,
    reload: vi.fn(),
  }),
}))

import { SideQuestionSettingsSection } from "./side-question-settings"

function snapshot(): AgentOptionsSnapshot {
  return {
    modes: null,
    config_options: [
      {
        id: "model",
        name: "Model",
        description: null,
        category: "model",
        kind: {
          type: "select",
          current_value: "default-model",
          options: [
            {
              value: "default-model",
              name: "Default model",
              description: null,
            },
            { value: "chosen-model", name: "Chosen model", description: null },
          ],
          groups: [],
        },
      },
      {
        id: "permission-mode",
        name: "Permission mode",
        description: null,
        category: "mode",
        kind: {
          type: "select",
          current_value: "default",
          options: [{ value: "default", name: "Default", description: null }],
          groups: [],
        },
      },
    ],
    available_commands: [],
    unapplied_config_ids: scene.unapplied,
  }
}

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SideQuestionSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  scene.call.mockReset()
  scene.saved = { configValues: {} }
  scene.probeError = null
  scene.unapplied = []
  scene.call.mockImplementation(
    async (command: string, args?: { settings: SideQuestionSettings }) => {
      if (command === "get_side_question_settings") return scene.saved
      if (command === "set_side_question_settings" && args) {
        scene.saved = args.settings
        return scene.saved
      }
      throw new Error(`Unexpected command: ${command}`)
    }
  )
})

describe("SideQuestionSettingsSection", () => {
  it("saves an independent model choice and restores it on remount", async () => {
    const view = renderSettings()
    const model = await screen.findByRole("combobox", { name: "Model" })
    expect(
      screen.queryByRole("combobox", { name: "Permission mode" })
    ).toBeNull()
    fireEvent.keyDown(model, { key: "Enter" })
    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", {
        name: "Chosen model",
      })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Save side question settings" })
    )
    await waitFor(() =>
      expect(scene.saved).toEqual({ configValues: { model: "chosen-model" } })
    )
    expect(
      scene.call.mock.calls.every(
        ([command]) =>
          command === "get_side_question_settings" ||
          command === "set_side_question_settings"
      )
    ).toBe(true)
    view.unmount()
    renderSettings()
    expect(
      await screen.findByRole("combobox", { name: "Model" })
    ).toHaveTextContent("Chosen model")
  })

  it("clears the saved override when defaults are restored and saved", async () => {
    scene.saved = { configValues: { model: "chosen-model" } }
    renderSettings()
    await screen.findByRole("combobox", { name: "Model" })
    fireEvent.click(screen.getByRole("button", { name: "Use agent defaults" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Save side question settings" })
    )
    await waitFor(() => expect(scene.saved).toEqual({ configValues: {} }))
  })

  it("shows load failures without exposing a save that could overwrite unknown settings", async () => {
    scene.call.mockRejectedValue(new Error("Settings unavailable"))
    renderSettings()
    expect(await screen.findByText("Settings unavailable")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Save side question settings" })
    ).toBeNull()
  })
})
