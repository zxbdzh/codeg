"use client"

import { MessageCircleQuestionMark } from "lucide-react"
import { useTranslations } from "next-intl"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"

export function SideQuestionSettingsSection() {
  const t = useTranslations("Folder.sideQuestion")

  return (
    <div id="side-question-settings" className="scroll-mt-4">
      <SettingsSection
        icon={MessageCircleQuestionMark}
        title={t("settings.title")}
        description={t("settings.description")}
      >
        <SettingCard>
          <SettingRow
            title={t("settings.engine")}
            control={<span className="text-xs">{t("followCurrent")}</span>}
          />
        </SettingCard>
      </SettingsSection>
    </div>
  )
}
