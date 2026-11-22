import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockIpc = vi.hoisted(() => ({
  call: vi.fn(),
}))

vi.mock(import("@/lib/transport"), async (importOriginal) => ({
  ...(await importOriginal()),
  getShellTransport: () => ({
    call: mockIpc.call,
    subscribe: vi.fn(),
    isDesktop: () => true,
  }),
}))

import { BrowserToolbar } from "./browser-toolbar"
import { BrowserSettings } from "@/components/settings/browser-settings"
import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import { resetBrowserCapabilitiesCacheForTests } from "@/lib/browser/browser-api"
import { resetBrowserPrefsForTests } from "@/lib/browser/browser-prefs"
import { resetBrowserTabStoreForTests } from "@/lib/browser/browser-tab-store"
import type { BrowserTabState } from "@/lib/browser/types"

const profiles = [
  { id: "ego-personal", name: "Personal", isDefault: true },
  { id: "ego-work", name: "Work", isDefault: false },
]

const capabilities = {
  available: true,
  surface: "child",
  platform: "windows",
  channel: "native",
  reasons: [],
  isolatedStorage: true,
  proxy: { url: null, applies: "live", reason: null },
  downloadsDir: "C:\\Users\\dev\\Downloads",
  docGuest: true,
  profiles: true,
  signInUserAgent: true,
  ownedWindowControls: true,
  remoteEgress: false,
  policy: { enabled: true, managedRules: [], managedSource: null },
}

let platform = "windows"
let settings = {
  sourceProfileId: null as string | null,
  sourceProfileName: null as string | null,
  allowAgentImport: false,
}
let importResult: {
  tabId: string
  status: "imported" | "unchanged" | "refused"
  cookiesImported: number
  storageImported: number
  skippedExpired: number
  error?: string
  note?: string
} = {
  tabId: "abc",
  status: "imported" as const,
  cookiesImported: 3,
  storageImported: 2,
  skippedExpired: 1,
  note: "secret-cookie-value-must-not-appear",
}

beforeEach(() => {
  resetBrowserCapabilitiesCacheForTests()
  resetBrowserPrefsForTests()
  resetBrowserTabStoreForTests()
  platform = "windows"
  settings = {
    sourceProfileId: null,
    sourceProfileName: null,
    allowAgentImport: false,
  }
  importResult = {
    tabId: "abc",
    status: "imported",
    cookiesImported: 3,
    storageImported: 2,
    skippedExpired: 1,
    note: "secret-cookie-value-must-not-appear",
  }
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  })
  mockIpc.call.mockReset()
  mockIpc.call.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command === "browser_capabilities")
        return { ...capabilities, platform }
      if (command === "browser_ego_import_profiles") return profiles
      if (command === "browser_ego_import_settings") return settings
      if (command === "browser_set_ego_import_settings") {
        settings = args.settings as typeof settings
        return settings
      }
      if (command === "browser_import_ego_session") return importResult
      throw new Error(`Unexpected Tauri command: ${command}`)
    }
  )
})

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserSettings />
    </NextIntlClientProvider>
  )
}

function tabIn(): BrowserWorkspaceTab {
  return {
    id: "browser:abc",
    kind: "browser",
    folderId: 1,
    title: "example.com",
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: false,
    readonly: true,
    browser: {
      initialUrl: "https://example.com/account",
      openerTabId: null,
      profile: "default",
    },
  } as BrowserWorkspaceTab
}

const loadedTabState: BrowserTabState = {
  tabId: "abc",
  ownerWindow: "main",
  kind: "page",
  surface: "child",
  channel: "native",
  channelError: null,
  url: "https://example.com/account",
  requestedUrl: "https://example.com/account",
  title: "Example",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  origin: "https://example.com",
  zoom: 1,
  error: null,
  remoteHost: null,
  openerTabId: null,
  profile: "default",
  agentGrant: null,
}

function renderToolbar(state = loadedTabState) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserToolbar tab={tabIn()} state={state} />
    </NextIntlClientProvider>
  )
}

async function openMenu(trigger: Element) {
  await act(async () => {
    for (const type of ["pointerdown", "pointerup", "click"]) {
      fireEvent(
        trigger,
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
        })
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function chooseProfile(label: string, profileName: string) {
  fireEvent.click(await screen.findByRole("combobox", { name: label }))
  fireEvent.click(await screen.findByRole("option", { name: profileName }))
}

describe("Ego login import UI", () => {
  it("binds one source profile and keeps agent import off until enabled", async () => {
    renderSettings()

    const source = await screen.findByRole("combobox", {
      name: "Ego source profile",
    })
    const agentImport = screen.getByRole("switch", {
      name: "Allow AI to import login state",
    })

    expect(agentImport).not.toBeChecked()
    expect(agentImport).toBeDisabled()

    await chooseProfile("Ego source profile", "Work")
    await waitFor(() =>
      expect(mockIpc.call).toHaveBeenCalledWith(
        "browser_set_ego_import_settings",
        {
          settings: {
            sourceProfileId: "ego-work",
            sourceProfileName: "Work",
            allowAgentImport: false,
          },
        }
      )
    )
    expect(source).toHaveTextContent("Work")
    expect(agentImport).toBeEnabled()

    fireEvent.click(agentImport)
    await waitFor(() =>
      expect(mockIpc.call).toHaveBeenLastCalledWith(
        "browser_set_ego_import_settings",
        {
          settings: {
            sourceProfileId: "ego-work",
            sourceProfileName: "Work",
            allowAgentImport: true,
          },
        }
      )
    )
    expect(agentImport).toBeChecked()
  })

  it("lets a person bind the source during import and reports counts without values", async () => {
    renderToolbar()
    await openMenu(await screen.findByRole("button", { name: "More" }))

    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Import login state from Ego",
      })
    )
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument()
    expect(screen.getByText(/https:\/\/example\.com/)).toBeInTheDocument()
    expect(screen.getByText(/Default/)).toBeInTheDocument()

    const importButton = screen.getByRole("button", { name: "Import" })
    expect(importButton).toBeDisabled()
    await chooseProfile("Ego source profile", "Work")
    expect(
      screen.getByRole("combobox", { name: "Ego source profile" })
    ).toHaveTextContent("Work")
    fireEvent.click(importButton)

    await waitFor(() =>
      expect(mockIpc.call).toHaveBeenCalledWith(
        "browser_set_ego_import_settings",
        {
          settings: {
            sourceProfileId: "ego-work",
            sourceProfileName: "Work",
            allowAgentImport: false,
          },
        }
      )
    )
    await waitFor(() =>
      expect(mockIpc.call).toHaveBeenCalledWith("browser_import_ego_session", {
        tabId: "abc",
      })
    )
    expect(
      mockIpc.call.mock.calls.findIndex(
        ([command]) => command === "browser_set_ego_import_settings"
      )
    ).toBeLessThan(
      mockIpc.call.mock.calls.findIndex(
        ([command]) => command === "browser_import_ego_session"
      )
    )
    expect(
      await screen.findByText(
        /Imported 3 cookies and 2 site-storage items.*check whether you are signed in/i
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/secret-cookie-value-must-not-appear/)
    ).not.toBeInTheDocument()
  })

  it("stops on a conflict and never offers an overwrite action", async () => {
    importResult = {
      tabId: "abc",
      status: "refused" as const,
      cookiesImported: 0,
      storageImported: 0,
      skippedExpired: 0,
      error: "browser_ego_conflict",
    }
    renderToolbar()
    await openMenu(await screen.findByRole("button", { name: "More" }))
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Import login state from Ego",
      })
    )
    await chooseProfile("Ego source profile", "Work")
    const importButton = screen.getByRole("button", { name: "Import" })
    await waitFor(() => expect(importButton).toBeEnabled())
    fireEvent.click(importButton)
    await waitFor(() =>
      expect(mockIpc.call).toHaveBeenCalledWith("browser_import_ego_session", {
        tabId: "abc",
      })
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Existing login data for this site was not changed/
    )
    expect(
      screen.queryByRole("button", { name: /overwrite|replace/i })
    ).not.toBeInTheDocument()
  })

  it("disables import while the target tab is still loading", async () => {
    renderToolbar({ ...loadedTabState, loading: true })
    await openMenu(await screen.findByRole("button", { name: "More" }))

    expect(
      await screen.findByRole("menuitem", {
        name: "Import login state from Ego",
      })
    ).toHaveAttribute("aria-disabled", "true")
  })

  it("hides settings and the import action outside Windows desktop", async () => {
    platform = "macos"
    const settingsPage = renderSettings()
    await waitFor(() =>
      expect(mockIpc.call).toHaveBeenCalledWith("browser_capabilities", {})
    )
    expect(
      screen.queryByRole("combobox", { name: "Ego source profile" })
    ).not.toBeInTheDocument()
    expect(mockIpc.call).not.toHaveBeenCalledWith(
      "browser_ego_import_profiles",
      {}
    )
    settingsPage.unmount()

    renderToolbar()
    await openMenu(await screen.findByRole("button", { name: "More" }))
    expect(
      screen.queryByRole("menuitem", {
        name: "Import login state from Ego",
      })
    ).not.toBeInTheDocument()
    expect(mockIpc.call).not.toHaveBeenCalledWith(
      "browser_ego_import_profiles",
      {}
    )
  })
})
