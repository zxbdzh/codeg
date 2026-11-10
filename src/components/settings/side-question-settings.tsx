"use client"

import { useEffect, useState } from "react"
import { Loader2, MessageCircleQuestionMark, RotateCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAgentOptions } from "@/components/automations/use-agent-options"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/app-error"
import {
  getSideQuestionSettings,
  setSideQuestionSettings,
  type SideQuestionSettings,
} from "@/lib/side-question"
import { getTransport } from "@/lib/transport"
import {
  findModelRow,
  OptionBlock,
  OverrideOptionRow,
  rowOffers,
  useOptionRows,
} from "./agent-options-editor"

const DEFAULT_SETTINGS: SideQuestionSettings = { configValues: {} }

export function SideQuestionSettingsSection() {
  const t = useTranslations("Folder.sideQuestion")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [persisted, setPersisted] = useState<SideQuestionSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const probe = useAgentOptions(
    "claude_code",
    null,
    persisted !== null,
    settings.configValues
  )
  const rows = useOptionRows("claude_code", probe.snapshot)
  // 只提供模型和推理选项，不把权限、工具或主会话模式混进旁问模型设置。
  const modelRows = rows?.filter(
    (row) =>
      row.kind !== "mode" &&
      (row.id === "model" ||
        row.id === "effort" ||
        row.option.category === "model" ||
        row.option.category === "thought_level")
  )
  const hasOverrides = Object.keys(settings.configValues).length > 0
  const unapplied = probe.snapshot?.unapplied_config_ids ?? []
  const selectedModel = settings.configValues.model
  const modelRow = rows ? findModelRow(rows) : null
  const visibleRows = probe.current
    ? (modelRows ?? [])
    : modelRow
      ? [modelRow]
      : []
  const notApplied =
    (selectedModel !== undefined &&
      probe.snapshot?.unapplied_config_ids === undefined) ||
    Object.entries(settings.configValues).some(([id, value]) => {
      const row = modelRows?.find((candidate) => candidate.id === id)
      return (
        unapplied.includes(id) || (row !== undefined && !rowOffers(row, value))
      )
    })
  const dirty = JSON.stringify(settings) !== JSON.stringify(persisted)

  useEffect(() => {
    let disposed = false
    void getSideQuestionSettings(getTransport())
      .then((loaded) => {
        if (disposed) return
        setSettings(loaded)
        setPersisted(loaded)
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(toErrorMessage(error))
      })
    return () => {
      disposed = true
    }
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const saved = await setSideQuestionSettings(getTransport(), settings)
      setSettings(saved)
      setPersisted(saved)
      toast.success(t("settings.saved"))
    } catch (error: unknown) {
      toast.error(toErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div id="side-question-settings" className="scroll-mt-4">
      <SettingsSection
        icon={MessageCircleQuestionMark}
        title={t("settings.title")}
        description={t("settings.description")}
      >
        {loadError ? <SettingsError>{loadError}</SettingsError> : null}
        {persisted === null && !loadError ? (
          <p
            role="status"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {tm("probing")}
          </p>
        ) : null}
        {persisted !== null ? (
          <>
            <SettingCard>
              <SettingRow
                title={t("settings.engine")}
                control={<span className="text-xs">Claude Code</span>}
              />
              {visibleRows.map((row) => (
                <OptionBlock key={row.id}>
                  <OverrideOptionRow
                    row={row}
                    value={settings.configValues[row.id] ?? null}
                    disabled={saving}
                    onChange={(next) => {
                      const configValues = { ...settings.configValues }
                      if (next === null) delete configValues[row.id]
                      else configValues[row.id] = next
                      setSettings({ configValues })
                    }}
                  />
                </OptionBlock>
              ))}
              {!probe.current && !probe.error ? (
                <OptionBlock>
                  <p role="status" className="text-xs text-muted-foreground">
                    {tm("probing")}
                  </p>
                </OptionBlock>
              ) : null}
            </SettingCard>
            {probe.error ? <SettingsError>{probe.error}</SettingsError> : null}
            {notApplied && probe.current ? (
              <SettingsError>{t("settings.notApplied")}</SettingsError>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving || probe.loading}
                onClick={probe.reload}
              >
                <RotateCw className="size-3.5" aria-hidden />
                {t("settings.refresh")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving || !hasOverrides}
                onClick={() => setSettings(DEFAULT_SETTINGS)}
              >
                {t("settings.reset")}
              </Button>
              <SettingsSaveBar
                className="ms-auto pt-0"
                onSave={() => void save()}
                saving={saving}
                disabled={
                  !dirty ||
                  (hasOverrides &&
                    (!probe.current || notApplied || Boolean(probe.error)))
                }
                label={t("settings.save")}
                savingLabel={t("settings.saving")}
              />
            </div>
          </>
        ) : null}
      </SettingsSection>
    </div>
  )
}
