import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebAppInstallProvider } from "@/components/providers/web-app-install-provider"
import en from "@/i18n/messages/en.json"
import { WebAppInstallSettings } from "./web-app-install-settings"

const platform = vi.hoisted(() => ({ desktop: false }))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => platform.desktop,
}))

let display: EventTarget & { matches: boolean }

beforeEach(() => {
  platform.desktop = false
  display = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal("isSecureContext", true)
  vi.stubGlobal("matchMedia", () => display)
  vi.stubGlobal("navigator", {
    userAgent: "Chrome",
    platform: "Win32",
    maxTouchPoints: 0,
  })
})

afterEach(() => vi.unstubAllGlobals())

function mount(visible = true) {
  const tree = (show: boolean) => (
    <NextIntlClientProvider locale="en" messages={en}>
      <WebAppInstallProvider>
        {show ? <WebAppInstallSettings /> : null}
      </WebAppInstallProvider>
    </NextIntlClientProvider>
  )
  const view = render(tree(visible))
  return { ...view, show: () => view.rerender(tree(true)) }
}

function installEvent(outcome: "accepted" | "dismissed" = "dismissed") {
  return Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome }),
  })
}

describe("Web App installation", () => {
  it("keeps an install event captured before the settings page opens", async () => {
    const view = mount(false)
    const event = installEvent()
    act(() => window.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    view.show()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install app" }))
    })
    expect(event.prompt).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull()
    expect(screen.getByText(en.WebAppInstall.browserMenu)).toBeInTheDocument()
  })

  it("only prompts once while installation is pending", async () => {
    mount()
    let resolveChoice!: (choice: { outcome: "accepted" }) => void
    const event = Object.assign(installEvent(), {
      userChoice: new Promise<{ outcome: "accepted" }>((resolve) => {
        resolveChoice = resolve
      }),
    })
    act(() => window.dispatchEvent(event))
    const button = screen.getByRole("button", { name: "Install app" })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(event.prompt).toHaveBeenCalledOnce()
    expect(button).toBeDisabled()
    await act(async () => resolveChoice({ outcome: "accepted" }))
    expect(screen.getByText(en.WebAppInstall.accepted)).toBeInTheDocument()
    expect(screen.queryByText(en.WebAppInstall.installed)).toBeNull()
    act(() => window.dispatchEvent(new Event("appinstalled")))
    expect(screen.getByText(en.WebAppInstall.installed)).toBeInTheDocument()
  })

  it("reports a failed prompt and can use a new browser event", async () => {
    mount()
    const failed = installEvent()
    failed.prompt.mockRejectedValueOnce(new Error("Browser refused"))
    act(() => window.dispatchEvent(failed))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install app" }))
    })
    expect(screen.getByRole("alert")).toHaveTextContent(en.WebAppInstall.failed)
    const next = installEvent()
    act(() => window.dispatchEvent(next))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install app" }))
    })
    expect(next.prompt).toHaveBeenCalledOnce()
  })

  it("gives Safari instructions on an iPad with a desktop user agent", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Macintosh Safari",
      platform: "MacIntel",
      maxTouchPoints: 5,
    })
    mount()
    expect(screen.getAllByRole("listitem")).toHaveLength(3)
    expect(screen.getByText(en.WebAppInstall.iosShare)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull()
  })

  it("explains HTTPS on an insecure LAN page without suppressing browser UI", () => {
    vi.stubGlobal("isSecureContext", false)
    mount()
    const event = installEvent()
    act(() => window.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
    expect(screen.getByText(en.WebAppInstall.httpsRequired)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull()
  })

  it("recognizes standalone launch and live display-mode changes", () => {
    mount()
    act(() => {
      display.matches = true
      display.dispatchEvent(new Event("change"))
    })
    expect(screen.getByText(en.WebAppInstall.standalone)).toBeInTheDocument()
    expect(screen.queryByText(en.WebAppInstall.browserMenu)).toBeNull()
  })

  it("recognizes the iOS standalone flag", () => {
    vi.stubGlobal("navigator", {
      userAgent: "iPhone",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: true,
    })
    mount()
    expect(screen.getByText(en.WebAppInstall.standalone)).toBeInTheDocument()
  })

  it("does not expose browser installation in the desktop app", () => {
    platform.desktop = true
    mount()
    const event = installEvent()
    act(() => window.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByText(en.WebAppInstall.title)).toBeNull()
  })

  it("removes event listeners when the root unmounts", () => {
    const view = mount()
    view.unmount()
    const event = installEvent()
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
