import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AgentPluginIndicator } from "@/lib/types"

const fake = vi.hoisted(() => ({
  list: vi.fn<(...args: unknown[]) => Promise<AgentPluginIndicator[]>>(),
}))

vi.mock("@/lib/api", () => ({
  acpListAgentPluginIndicators: fake.list,
}))

import { ComposerPluginIndicators } from "./composer-plugin-indicators"

function indicator(
  over: Partial<AgentPluginIndicator> & Pick<AgentPluginIndicator, "id">
): AgentPluginIndicator {
  return {
    enabled: true,
    state: "unknown",
    source: "session_state_unobservable",
    scope: "session",
    ...over,
  }
}

function renderIndicators() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposerPluginIndicators
        agentType="codex"
        workspacePath="/workspace/repo"
      />
    </NextIntlClientProvider>
  )
}

describe("ComposerPluginIndicators", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows only plugins the current agent reports as installed", async () => {
    fake.list.mockResolvedValue([
      indicator({ id: "ponytail", state: "full", scope: "user_shared" }),
    ])

    renderIndicators()

    expect(
      await screen.findByRole("button", { name: "Ponytail: Full" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /I Have ADHD/i })).toBeNull()
    expect(fake.list).toHaveBeenCalledWith({
      agentType: "codex",
      workspacePath: "/workspace/repo",
    })
  })

  it("explains that the Ponytail state is shared by sessions in the project", async () => {
    fake.list.mockResolvedValue([
      indicator({
        id: "ponytail",
        state: "ultra",
        source: "project_mode_marker",
        scope: "project_shared",
      }),
    ])

    renderIndicators()
    fireEvent.click(
      await screen.findByRole("button", { name: "Ponytail: Ultra" })
    )

    expect(
      await screen.findByText("Shared by sessions in this project")
    ).toBeInTheDocument()
    expect(screen.getByText("Workspace mode marker")).toBeInTheDocument()
  })

  it("never turns an unobservable session state into an active claim", async () => {
    fake.list.mockResolvedValue([indicator({ id: "i-have-adhd" })])

    renderIndicators()

    expect(
      await screen.findByRole("button", { name: "I Have ADHD: Unknown" })
    ).toBeInTheDocument()
  })

  it("renders no marks when the agent has neither plugin installed", async () => {
    fake.list.mockResolvedValue([])

    renderIndicators()

    expect(
      await screen.queryByRole("button", { name: /I Have ADHD|Ponytail/ })
    ).toBeNull()
  })
})
