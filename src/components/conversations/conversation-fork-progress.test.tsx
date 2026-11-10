import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { ConversationForkProgress } from "./conversation-fork-progress"

function view(open: boolean, onBackgroundClick = vi.fn()) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <button type="button" onClick={onBackgroundClick}>
        Switch conversation
      </button>
      <ConversationForkProgress open={open} />
    </NextIntlClientProvider>
  )
}

afterEach(cleanup)

describe("ConversationForkProgress", () => {
  it("blocks background clicks, drop and global shortcuts while forking", () => {
    const onBackgroundClick = vi.fn()
    const onShortcut = vi.fn()
    render(view(true, onBackgroundClick))
    window.addEventListener("keydown", onShortcut)
    try {
      const dialog = screen.getByRole("dialog", {
        name: enMessages.ResearchBranch.forking,
      })
      expect(dialog).toHaveAttribute("aria-busy", "true")
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
      fireEvent.click(screen.getByText("Switch conversation"))
      expect(onBackgroundClick).not.toHaveBeenCalled()
      for (const key of ["Escape", "Tab", "Enter", "t", "w"]) {
        expect(fireEvent.keyDown(window, { key, ctrlKey: true })).toBe(false)
      }
      expect(onShortcut).not.toHaveBeenCalled()
      expect(fireEvent.drop(document.body)).toBe(false)
      expect(dialog).toBeInTheDocument()
    } finally {
      window.removeEventListener("keydown", onShortcut)
    }
  })

  it("restores interaction after the operation settles", () => {
    const onBackgroundClick = vi.fn()
    const rendered = render(view(true, onBackgroundClick))
    rendered.rerender(view(false, onBackgroundClick))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Switch conversation" }))
    expect(onBackgroundClick).toHaveBeenCalledTimes(1)
    expect(fireEvent.keyDown(window, { key: "t", ctrlKey: true })).toBe(true)
  })

  it("releases global event handlers if its owning view unmounts", () => {
    const rendered = render(view(true))
    rendered.unmount()
    expect(fireEvent.click(document.body)).toBe(true)
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(true)
    expect(fireEvent.drop(document.body)).toBe(true)
  })
})
