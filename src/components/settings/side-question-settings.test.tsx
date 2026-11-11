import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const scene = vi.hoisted(() => ({
  call: vi.fn(),
  probe: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: scene.call }),
}))
vi.mock("@/components/automations/use-agent-options", () => ({
  useAgentOptions: scene.probe,
}))

import { SideQuestionSettingsSection } from "./side-question-settings"

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SideQuestionSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  scene.call.mockReset()
  scene.probe.mockReset()
})

describe("SideQuestionSettingsSection", () => {
  it("explains that model and reasoning effort follow the conversation", () => {
    renderSettings()
    expect(
      screen.getByText(
        "Side questions follow the current conversation's model and reasoning effort. No separate configuration is needed."
      )
    ).toBeInTheDocument()
    expect(screen.getByText("Follow current conversation")).toBeInTheDocument()
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
    expect(scene.probe).not.toHaveBeenCalled()
    expect(scene.call).not.toHaveBeenCalled()
  })

  it("never probes or reads and saves legacy overrides on remount", () => {
    const view = renderSettings()
    view.unmount()
    renderSettings()
    expect(scene.probe).not.toHaveBeenCalled()
    expect(scene.call).not.toHaveBeenCalled()
  })
})
