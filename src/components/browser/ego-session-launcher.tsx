"use client"

import { Globe } from "lucide-react"
import { useTranslations } from "next-intl"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { useTabStore } from "@/stores/tab-store"
import { Button } from "@/components/ui/button"

export function EgoSessionLauncher() {
  const t = useTranslations("Browser.tab")
  const { openBrowserTab } = useWorkspaceActions()
  const sessionId = useTabStore(
    (state) =>
      state.rawTabs.find((tab) => tab.id === state.activeTabId)?.conversationId
  )
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6"
      disabled={!sessionId}
      aria-label={t("untitled")}
      title={t("untitled")}
      onClick={() => openBrowserTab("about:blank")}
    >
      <Globe className="size-3.5" />
    </Button>
  )
}
