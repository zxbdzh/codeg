"use client"

import { useTranslations } from "next-intl"
import { PromptForkPicker } from "@/components/conversations/prompt-fork-picker"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationForkStore } from "@/stores/conversation-fork-store"

export function ConversationForkTab() {
  const t = useTranslations("ResearchBranch")
  const activeTabId = useTabStore((state) => state.activeTabId)
  const target = useConversationForkStore((state) =>
    activeTabId ? state.byTab[activeTabId] : undefined
  )

  if (!target) {
    return (
      <p className="p-3 text-[13px] leading-relaxed text-muted-foreground">
        {t("connectionRequired")}
      </p>
    )
  }

  return (
    <PromptForkPicker
      key={`${activeTabId}:${target.conversationId}`}
      embedded
      conversationId={target.conversationId}
      unavailableReason={target.unavailable ? t(target.unavailable) : null}
      onSelect={target.onSelect}
    />
  )
}
