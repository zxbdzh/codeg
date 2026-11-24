"use client"

import { useCallback, useEffect, useState } from "react"
import { Coins, Eraser, FlaskConical, Loader2, Save } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  getWhaleBalanceSettings,
  testWhaleBalanceSettings,
  updateWhaleBalanceSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  UpdateWhaleBalanceSettingsInput,
  WhaleBalanceSettingsView,
  WhaleBalanceTestResult,
} from "@/lib/types"

const DEFAULT_METHOD = "GET"
const DEFAULT_AUTH_HEADER = "Bearer {key}"
const DEFAULT_REMAINING_PATH = "balance"
const DEFAULT_USED_PATH = "api_key_quota.used"
const DEFAULT_SCALE = "1"
const DEFAULT_POLL_INTERVAL = "60"

function formatAmount(value: number): string {
  const safe = Math.abs(value) < 0.005 ? 0 : value
  return safe.toFixed(2)
}

export function WhaleBalanceSettingsSection() {
  const t = useTranslations("WhaleBalanceSettings")

  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sectionOpen, setSectionOpen] = useState(false)

  const [savedView, setSavedView] = useState<WhaleBalanceSettingsView | null>(
    null
  )
  const [enabled, setEnabled] = useState(false)
  const [accountName, setAccountName] = useState("")
  const [url, setUrl] = useState("")
  const [method, setMethod] = useState(DEFAULT_METHOD)
  const [authHeader, setAuthHeader] = useState(DEFAULT_AUTH_HEADER)
  // 仅保存用户本次新输入的密钥；后端已存密钥绝不回填到前端输入框。
  const [apiKeyInput, setApiKeyInput] = useState("")
  const [clearApiKey, setClearApiKey] = useState(false)
  const [remainingPath, setRemainingPath] = useState(DEFAULT_REMAINING_PATH)
  const [usedPath, setUsedPath] = useState(DEFAULT_USED_PATH)
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [pollIntervalSecs, setPollIntervalSecs] = useState(
    DEFAULT_POLL_INTERVAL
  )

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<WhaleBalanceTestResult | null>(
    null
  )

  const applyView = useCallback((view: WhaleBalanceSettingsView) => {
    setSavedView(view)
    setEnabled(view.enabled)
    setAccountName(view.accountName)
    setUrl(view.url)
    setMethod(view.method || DEFAULT_METHOD)
    setAuthHeader(view.authHeader || DEFAULT_AUTH_HEADER)
    setApiKeyInput("")
    setClearApiKey(false)
    setRemainingPath(view.remainingPath || DEFAULT_REMAINING_PATH)
    setUsedPath(view.usedPath ?? "")
    setScale(String(view.scale ?? 1))
    setPollIntervalSecs(String(view.pollIntervalSecs ?? 60))
  }, [])

  useEffect(() => {
    let cancelled = false
    getWhaleBalanceSettings()
      .then((view) => {
        if (cancelled) return
        applyView(view)
        // 已启用或已填写过地址时默认展开配置区，未配置时保持折叠减少视觉噪音。
        setSectionOpen(view.enabled || view.url.trim().length > 0)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(toErrorMessage(err))
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [applyView])

  const buildPayload = useCallback(
    (overrideEnabled?: boolean): UpdateWhaleBalanceSettingsInput => {
      const parsedScale = Number(scale)
      const parsedInterval = Number.parseInt(pollIntervalSecs, 10)
      const trimmedKey = apiKeyInput.trim()

      return {
        enabled: overrideEnabled ?? enabled,
        accountName: accountName.trim(),
        url: url.trim(),
        method,
        authHeader: authHeader.trim() || DEFAULT_AUTH_HEADER,
        apiKey: trimmedKey.length > 0 ? trimmedKey : null,
        clearApiKey: clearApiKey && trimmedKey.length === 0,
        remainingPath: remainingPath.trim() || DEFAULT_REMAINING_PATH,
        usedPath: usedPath.trim(),
        scale:
          Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1,
        pollIntervalSecs:
          Number.isFinite(parsedInterval) && parsedInterval > 0
            ? parsedInterval
            : 60,
      }
    },
    [
      accountName,
      apiKeyInput,
      authHeader,
      clearApiKey,
      enabled,
      method,
      pollIntervalSecs,
      remainingPath,
      scale,
      url,
      usedPath,
    ]
  )

  const handleToggleEnabled = useCallback(
    async (next: boolean) => {
      const prev = enabled
      setEnabled(next)
      if (next) {
        setSectionOpen(true)
      }

      // 首次启用但尚未配置过接口地址时，仅展开表单等待用户补全并保存，避免空配置落库。
      if (!savedView || (next && savedView.url.trim().length === 0)) {
        return
      }

      setSaving(true)
      try {
        // 仅切换开关时基于已持久化视图更新，防止把未保存的半成品表单草稿提前提交。
        const updated = await updateWhaleBalanceSettings({
          enabled: next,
          accountName: savedView.accountName,
          url: savedView.url,
          method: savedView.method,
          authHeader: savedView.authHeader,
          apiKey: null,
          clearApiKey: false,
          remainingPath: savedView.remainingPath,
          usedPath: savedView.usedPath,
          scale: savedView.scale,
          pollIntervalSecs: savedView.pollIntervalSecs,
        })
        setSavedView(updated)
        setEnabled(updated.enabled)
      } catch (err) {
        setEnabled(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [enabled, savedView, t]
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    setTestResult(null)
    try {
      const updated = await updateWhaleBalanceSettings(buildPayload())
      applyView(updated)
      toast.success(t("saveSuccess"))
    } catch (err) {
      toast.error(t("saveFailed", { message: toErrorMessage(err) }))
    } finally {
      setSaving(false)
    }
  }, [applyView, buildPayload, t])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testWhaleBalanceSettings(buildPayload())
      setTestResult(result)
    } catch (err) {
      setTestResult({
        ok: false,
        balance: null,
        used: null,
        error: toErrorMessage(err),
      })
    } finally {
      setTesting(false)
    }
  }, [buildPayload])

  const hasSavedKey = Boolean(savedView?.hasApiKey) && !clearApiKey

  return (
    <SettingsSection
      icon={Coins}
      title={t("title")}
      description={t("description")}
      collapsible
      open={sectionOpen}
      onOpenChange={setSectionOpen}
      control={
        <Switch
          id="whale-balance-enabled"
          aria-label={t("enableAriaLabel")}
          checked={enabled}
          disabled={!loaded || saving}
          onCheckedChange={(next) => void handleToggleEnabled(next)}
        />
      }
    >
      {loadError ? (
        <SettingsError>{t("loadFailed", { message: loadError })}</SettingsError>
      ) : (
        <SettingCard>
          <SettingRow
            title={t("accountNameLabel")}
            description={t("accountNameDescription")}
            htmlFor="whale-account-name"
          >
            <Input
              id="whale-account-name"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder={t("accountNamePlaceholder")}
              disabled={saving}
              className="h-8 bg-background text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t("urlLabel")}
            description={t("urlDescription")}
            htmlFor="whale-balance-url"
          >
            <div className="flex gap-2">
              <Select
                value={method}
                onValueChange={setMethod}
                disabled={saving}
              >
                <SelectTrigger
                  aria-label={t("methodLabel")}
                  size="sm"
                  className="w-24 shrink-0 bg-background text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                </SelectContent>
              </Select>
              <Input
                id="whale-balance-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("urlPlaceholder")}
                disabled={saving}
                className="h-8 flex-1 bg-background font-mono text-xs"
              />
            </div>
          </SettingRow>

          <SettingRow
            title={t("authHeaderLabel")}
            description={t("authHeaderDescription")}
            htmlFor="whale-auth-header"
          >
            <Input
              id="whale-auth-header"
              value={authHeader}
              onChange={(e) => setAuthHeader(e.target.value)}
              placeholder="Bearer {key}"
              disabled={saving}
              className="h-8 bg-background font-mono text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t("apiKeyLabel")}
            description={
              clearApiKey
                ? t("apiKeyWillClear")
                : hasSavedKey
                  ? t("apiKeySavedDescription")
                  : t("apiKeyDescription")
            }
            htmlFor="whale-api-key"
          >
            <div className="flex gap-2">
              <Input
                id="whale-api-key"
                type="password"
                autoComplete="off"
                value={apiKeyInput}
                onChange={(e) => {
                  setApiKeyInput(e.target.value)
                  if (e.target.value.trim().length > 0) {
                    setClearApiKey(false)
                  }
                }}
                placeholder={
                  hasSavedKey
                    ? t("apiKeySavedPlaceholder", {
                        hint: savedView?.apiKeyHint ?? "****",
                      })
                    : t("apiKeyPlaceholder")
                }
                disabled={saving}
                className="h-8 flex-1 bg-background font-mono text-xs"
              />
              {savedView?.hasApiKey && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setApiKeyInput("")
                    setClearApiKey((v) => !v)
                  }}
                >
                  <Eraser className="size-3.5" />
                  {clearApiKey ? t("undoClearApiKey") : t("clearApiKey")}
                </Button>
              )}
            </div>
          </SettingRow>

          <SettingRow
            title={t("pathsLabel")}
            description={t("pathsDescription")}
            htmlFor="whale-remaining-path"
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="whale-remaining-path"
                  className="text-2xs text-muted-foreground"
                >
                  {t("remainingPathLabel")}
                </label>
                <Input
                  id="whale-remaining-path"
                  value={remainingPath}
                  onChange={(e) => setRemainingPath(e.target.value)}
                  placeholder={DEFAULT_REMAINING_PATH}
                  disabled={saving}
                  className="h-8 bg-background font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="whale-used-path"
                  className="text-2xs text-muted-foreground"
                >
                  {t("usedPathLabel")}
                </label>
                <Input
                  id="whale-used-path"
                  value={usedPath}
                  onChange={(e) => setUsedPath(e.target.value)}
                  placeholder={DEFAULT_USED_PATH}
                  disabled={saving}
                  className="h-8 bg-background font-mono text-xs"
                />
              </div>
            </div>
          </SettingRow>

          <SettingRow
            title={t("pollingLabel")}
            description={t("pollingDescription")}
            htmlFor="whale-poll-interval"
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="whale-scale"
                  className="text-2xs text-muted-foreground"
                >
                  {t("scaleLabel")}
                </label>
                <Input
                  id="whale-scale"
                  type="number"
                  step="any"
                  min="0.0001"
                  value={scale}
                  onChange={(e) => setScale(e.target.value)}
                  disabled={saving}
                  className="h-8 bg-background font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="whale-poll-interval"
                  className="text-2xs text-muted-foreground"
                >
                  {t("pollIntervalLabel")}
                </label>
                <Input
                  id="whale-poll-interval"
                  type="number"
                  min="15"
                  max="3600"
                  value={pollIntervalSecs}
                  onChange={(e) => setPollIntervalSecs(e.target.value)}
                  disabled={saving}
                  className="h-8 bg-background font-mono text-xs"
                />
              </div>
            </div>
          </SettingRow>

          <div className="flex flex-wrap items-center justify-between gap-2 p-3">
            <div className="min-w-0 flex-1 text-xs">
              {testResult && (
                <span
                  className={
                    testResult.ok
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-destructive"
                  }
                >
                  {testResult.ok && testResult.balance !== null
                    ? testResult.used !== null
                      ? t("testSuccessWithUsed", {
                          balance: formatAmount(testResult.balance),
                          used: formatAmount(testResult.used),
                        })
                      : t("testSuccess", {
                          balance: formatAmount(testResult.balance),
                        })
                    : t("testFailed", {
                        message: testResult.error ?? t("unknownError"),
                      })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving || testing || url.trim().length === 0}
                onClick={() => void handleTest()}
              >
                {testing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FlaskConical className="size-3.5" />
                )}
                {t("testButton")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving || testing}
                onClick={() => void handleSave()}
              >
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                {t("saveButton")}
              </Button>
            </div>
          </div>
        </SettingCard>
      )}
    </SettingsSection>
  )
}
