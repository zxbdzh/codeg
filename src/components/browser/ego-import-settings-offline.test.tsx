import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock(import("@/lib/transport"), async (importOriginal) => ({
  ...(await importOriginal()),
  getShellTransport: () => ({
    call: ipc.call,
    subscribe: vi.fn(),
    isDesktop: () => true,
  }),
}))

import { BrowserEgoImportSettings } from "./browser-ego-import"
import messages from "@/i18n/messages/en.json"

it("allows revoking agent import while Ego is offline", async () => {
  const saved = {
    sourceProfileId: "ego-work",
    sourceProfileName: "Work",
    allowAgentImport: true,
  }
  ipc.call.mockImplementation(async (command, args) => {
    if (command === "browser_ego_import_profiles") throw new Error("offline")
    if (command === "browser_ego_import_settings") return saved
    if (command === "browser_set_ego_import_settings") return args.settings
    throw new Error("unexpected command")
  })
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BrowserEgoImportSettings />
    </NextIntlClientProvider>
  )
  const toggle = await screen.findByRole("switch")
  await waitFor(() => expect(toggle).toBeChecked())
  expect(toggle).toBeEnabled()
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(ipc.call).toHaveBeenCalledWith("browser_set_ego_import_settings", {
      settings: { ...saved, allowAgentImport: false },
    })
  )
  await waitFor(() => expect(toggle).not.toBeChecked())
})
