"use client"

import { useEffect, useState } from "react"
import { Bot, KeyRound } from "lucide-react"
import { useTranslations } from "next-intl"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  browserEgoImportProfiles,
  browserEgoImportSettings,
  browserImportEgoSession,
  browserSetEgoImportSettings,
  type EgoImportProfile,
  type EgoImportResult,
  type EgoImportSettings,
} from "@/lib/browser/ego-import"

const IMPORT_ERROR_KEYS = {
  browser_ego_unavailable: "egoImportErrorUnavailable",
  browser_ego_source_required: "egoImportErrorSourceRequired",
  browser_ego_source_missing: "egoImportErrorSourceMissing",
  browser_ego_import_disabled: "egoImportErrorDisabled",
  browser_ego_conflict: "egoImportErrorConflict",
  browser_ego_unsupported: "egoImportErrorUnsupported",
  browser_ego_failed: "egoImportErrorFailed",
  browser_grant_required: "egoImportErrorGrant",
  browser_control_required: "egoImportErrorGrant",
  browser_no_such_tab: "egoImportErrorTab",
  browser_blocked: "egoImportErrorBlocked",
} as const

export function BrowserEgoImportSettings() {
  const t = useTranslations("BrowserSettings")
  const [profiles, setProfiles] = useState<EgoImportProfile[]>([])
  const [settings, setSettings] = useState<EgoImportSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([browserEgoImportProfiles(), browserEgoImportSettings()])
      .then(([availableProfiles, savedSettings]) => {
        if (cancelled) return
        if (availableProfiles.status === "fulfilled")
          setProfiles(availableProfiles.value)
        // 撤销授权不能依赖 Ego 在线，来源不可用时仍须加载已保存的开关。
        if (savedSettings.status === "fulfilled")
          setSettings(savedSettings.value)
        else setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async (next: EgoImportSettings) => {
    setSaving(true)
    setFailed(false)
    try {
      setSettings(await browserSetEgoImportSettings(next))
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const selectedProfile = profiles.find(
    (profile) => profile.id === settings?.sourceProfileId
  )
  const sourceMissing =
    !!settings?.sourceProfileId && !selectedProfile && !loading

  return (
    <SettingCard>
      <SettingRow
        icon={KeyRound}
        title={t("egoImportTitle")}
        description={t("egoImportHint")}
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="browser-ego-source" className="text-xs">
              {t("egoImportSource")}
            </Label>
            <Select
              value={settings?.sourceProfileId ?? ""}
              disabled={loading || saving || profiles.length === 0}
              onValueChange={(id) => {
                const profile = profiles.find((item) => item.id === id)
                if (!profile || !settings) return
                void save({
                  ...settings,
                  sourceProfileId: profile.id,
                  sourceProfileName: profile.name,
                })
              }}
            >
              <SelectTrigger
                id="browser-ego-source"
                size="sm"
                className="w-full bg-background text-xs"
                aria-label={t("egoImportSource")}
              >
                <SelectValue placeholder={t("egoImportChooseSource")} />
              </SelectTrigger>
              <SelectContent align="start">
                {sourceMissing ? (
                  <SelectItem value={settings!.sourceProfileId!} disabled>
                    {settings?.sourceProfileName || t("egoImportMissingName")}
                  </SelectItem>
                ) : null}
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {profiles.length === 0 && !loading ? (
            <p className="text-xs text-muted-foreground">
              {t("egoImportNoProfiles")}
            </p>
          ) : null}
          {sourceMissing ? (
            <p className="text-xs text-muted-foreground">
              {t("egoImportSourceMissing", {
                name: settings?.sourceProfileName || "",
              })}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor="browser-ego-agent-import" className="text-sm">
                <Bot aria-hidden="true" className="size-3.5" />
                {t("egoImportAllowAgent")}
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("egoImportAllowAgentHint")}
              </p>
            </div>
            <Switch
              id="browser-ego-agent-import"
              checked={settings?.allowAgentImport ?? false}
              disabled={
                loading ||
                saving ||
                !settings ||
                (!settings.allowAgentImport && !selectedProfile)
              }
              onCheckedChange={(allowAgentImport) => {
                if (!settings || (allowAgentImport && !selectedProfile)) return
                void save({ ...settings, allowAgentImport })
              }}
            />
          </div>
          {failed ? (
            <p role="alert" className="text-xs text-destructive">
              {t("egoImportSaveFailed")}
            </p>
          ) : null}
        </div>
      </SettingRow>
    </SettingCard>
  )
}

function websiteOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null
  } catch {
    return null
  }
}

export function BrowserEgoImportDialog({
  open,
  onOpenChange,
  tabId,
  url,
  targetProfileName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabId: string
  url: string
  targetProfileName: string
}) {
  const t = useTranslations("Browser.toolbar")
  const [profiles, setProfiles] = useState<EgoImportProfile[]>([])
  const [settings, setSettings] = useState<EgoImportSettings | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState("")
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [operationFailed, setOperationFailed] = useState(false)
  const [result, setResult] = useState<EgoImportResult | null>(null)
  const site = websiteOrigin(url)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.all([browserEgoImportProfiles(), browserEgoImportSettings()])
      .then(([availableProfiles, savedSettings]) => {
        if (cancelled) return
        setProfiles(availableProfiles)
        setSettings(savedSettings)
        // 未绑定或已失效时必须由用户明确选择，避免多资料时猜错账号。
        if (
          savedSettings.sourceProfileId &&
          availableProfiles.some(
            (profile) => profile.id === savedSettings.sourceProfileId
          )
        ) {
          setSelectedProfileId(savedSettings.sourceProfileId)
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const boundProfile = profiles.find(
    (profile) => profile.id === settings?.sourceProfileId
  )
  const sourceProfile =
    boundProfile ??
    profiles.find((profile) => profile.id === selectedProfileId) ??
    null
  const needsSourceChoice = !boundProfile

  const importSession = async () => {
    if (!settings || !sourceProfile || !site || !tabId) return
    setImporting(true)
    setOperationFailed(false)
    try {
      if (needsSourceChoice) {
        const saved = await browserSetEgoImportSettings({
          ...settings,
          sourceProfileId: sourceProfile.id,
          sourceProfileName: sourceProfile.name,
        })
        setSettings(saved)
      }
      const imported = await browserImportEgoSession(tabId)
      setResult({
        tabId: imported.tabId,
        status: imported.status,
        cookiesImported: imported.cookiesImported,
        storageImported: imported.storageImported,
        skippedExpired: imported.skippedExpired,
        error: imported.error,
      })
    } catch {
      setOperationFailed(true)
    } finally {
      setImporting(false)
    }
  }

  let resultMessage: string | null = null
  if (result?.status === "imported") {
    resultMessage = t("egoImportResultImported", {
      cookies: result.cookiesImported,
      storage: result.storageImported,
      skipped: result.skippedExpired,
      site: site ?? url,
    })
  } else if (result?.status === "unchanged") {
    resultMessage = t("egoImportResultUnchanged", { site: site ?? url })
  } else if (result?.status === "refused") {
    // 结果状态不保留后端 note，避免任意诊断文本进入前端视图状态。
    const errorKey = result.error
      ? IMPORT_ERROR_KEYS[result.error as keyof typeof IMPORT_ERROR_KEYS]
      : undefined
    resultMessage = errorKey ? t(errorKey) : t("egoImportErrorFailed")
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("egoImportDialogTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("egoImportTarget", {
              site: site ?? t("egoImportUnknownSite"),
              profile: targetProfileName,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          {loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("egoImportLoading")}
            </p>
          ) : null}
          {needsSourceChoice && !loading && !loadFailed ? (
            <div className="space-y-1.5">
              <Label htmlFor="browser-ego-import-source">
                {t("egoImportSource")}
              </Label>
              <Select
                value={selectedProfileId}
                disabled={importing || profiles.length === 0}
                onValueChange={setSelectedProfileId}
              >
                <SelectTrigger
                  id="browser-ego-import-source"
                  className="w-full"
                  aria-label={t("egoImportSource")}
                >
                  <SelectValue placeholder={t("egoImportChooseSource")} />
                </SelectTrigger>
                <SelectContent align="start">
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {settings?.sourceProfileId ? (
                <p className="text-xs text-muted-foreground">
                  {t("egoImportSourceMissing", {
                    name: settings.sourceProfileName || "",
                  })}
                </p>
              ) : null}
              {profiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("egoImportNoProfiles")}
                </p>
              ) : null}
            </div>
          ) : null}
          {boundProfile ? (
            <p className="text-sm text-muted-foreground">
              {t("egoImportBoundSource", { name: boundProfile.name })}
            </p>
          ) : null}
          {loadFailed ? (
            <p role="alert" className="text-sm text-destructive">
              {t("egoImportErrorUnavailable")}
            </p>
          ) : null}
          {operationFailed ? (
            <p role="alert" className="text-sm text-destructive">
              {t("egoImportErrorFailed")}
            </p>
          ) : null}
          {resultMessage ? (
            <p
              role={result?.status === "refused" ? "alert" : "status"}
              aria-live="polite"
              className={
                result?.status === "refused"
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"
              }
            >
              {resultMessage}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={importing}>
            {result ? t("egoImportClose") : t("egoImportCancel")}
          </AlertDialogCancel>
          {!result ? (
            <Button
              type="button"
              disabled={
                loading ||
                loadFailed ||
                importing ||
                !settings ||
                !sourceProfile ||
                !site ||
                !tabId
              }
              onClick={() => void importSession()}
            >
              {importing ? t("egoImportImporting") : t("egoImportImport")}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
