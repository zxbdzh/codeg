import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { IdleUpdateStatus } from "./idle-update-status"

describe("IdleUpdateStatus", () => {
  it("keeps unknown reasons readable without exposing internal identifiers", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <IdleUpdateStatus
          state={{
            seq: 1,
            status: "waiting_for_idle",
            blockers: ["connection-private-id"],
          }}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("status")).toHaveTextContent(
      "Cannot confirm the app is idle"
    )
    expect(screen.queryByText("connection-private-id")).not.toBeInTheDocument()
  })
})
