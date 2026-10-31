import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const copy = vi.hoisted(() => vi.fn(async (_text: string) => true))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextToClipboard: copy,
}))

import {
  TitleFailureHost,
  showTitleFailure,
  titleFailureOf,
} from "./title-failure-dialog"

const failure = () =>
  titleFailureOf(
    {
      code: "network_error",
      message: "Failed to fetch update manifest",
      detail: "error sending request for url",
    },
    42
  )

beforeEach(() => {
  copy.mockClear()
  showTitleFailure(failure())
})

function show() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TitleFailureHost />
    </NextIntlClientProvider>
  )
}

describe("title failure dialog", () => {
  it("shows the real reason instead of a generic failure", () => {
    show()
    // toErrorMessage 优先用 detail，所以这里看到的是那条具体细节。
    expect(screen.getByTestId("title-failure-reason").textContent).toBe(
      "error sending request for url"
    )
    expect(screen.getByText(/Error code: network_error/)).toBeTruthy()
  })

  it("copies a diagnostic the user can send back", async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole("button", { name: "Copy error details" }))

    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1))
    const text = copy.mock.calls[0][0]
    expect(text).toContain("conversationId: 42")
    expect(text).toContain("code: network_error")
    expect(text).toContain("detail: error sending request for url")
  })
})
