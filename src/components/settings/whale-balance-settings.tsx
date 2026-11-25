"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Coins,
  Eraser,
  FlaskConical,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react"
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
  getWhaleBalancePresentation,
  getWhaleBalanceSettings,
  reconcileWhaleBalance,
  saveWhaleBalancePresentation,
  testWhaleBalanceSettings,
  updateWhaleBalanceSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  UpdateWhaleBalanceSettingsInput,
  WhaleBalanceModelView,
  WhaleBalancePresentation,
  WhaleBalanceSettingsView,
  WhaleBalanceTestResult,
} from "@/lib/types"

const DEFAULT_METHOD = "GET"
const DEFAULT_AUTH_HEADER = "Bearer {key}"
const DEFAULT_REMAINING_PATH = "balance"
const DEFAULT_USED_PATH = "api_key_quota.used"
const DEFAULT_SCALE = "1"
const DEFAULT_POLL_INTERVAL = "60"
const PROVIDER_TEMPLATES = [
  {
    id: "deepseek",
    name: "DeepSeek",
    accountName: "DeepSeek",
    url: "https://api.deepseek.com/user/balance",
    remainingPath: "balance_infos[0].total_balance",
    usedPath: "",
    totalPath: "",
    unitPath: "balance_infos[0].currency",
    scale: "1",
  },
  {
    id: "openai-compat",
    name: "OpenAI 兼容中转站",
    accountName: "OpenAI 兼容",
    url: "{base}/v1/dashboard/billing/subscription",
    remainingPath: "hard_limit_usd",
    usedPath: "total_usage",
    totalPath: "",
    unitPath: "",
    scale: "0.01",
  },
  {
    id: "zhipu",
    name: "智谱 GLM Coding Plan",
    accountName: "智谱 GLM",
    url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    remainingPath: "",
    usedPath: "percentage",
    totalPath: "",
    unitPath: "",
    scale: "1",
  },
  {
    id: "kimi-coding",
    name: "Kimi Coding",
    accountName: "Kimi Coding",
    url: "https://api.kimi.com/coding/v1/usages",
    remainingPath: "usage.remaining",
    usedPath: "",
    totalPath: "usage.limit",
    unitPath: "",
    scale: "1",
  },
  {
    id: "minimax-coding",
    name: "MiniMax Coding",
    accountName: "MiniMax Coding",
    url: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
    remainingPath: "model_remains[0].current_interval_remaining_percent",
    usedPath: "",
    totalPath: "",
    unitPath: "",
    scale: "1",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    accountName: "OpenCode Go",
    url: "https://opencode.ai/zen/go/v1/usage",
    remainingPath: "usage.rolling.percent",
    usedPath: "",
    totalPath: "",
    unitPath: "",
    scale: "1",
  },
  {
    id: "openai",
    name: "OpenAI",
    accountName: "OpenAI",
    url: "https://api.openai.com/v1/models",
    remainingPath: "",
    usedPath: "",
    totalPath: "",
    unitPath: "",
    scale: "1",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    accountName: "Anthropic",
    url: "https://api.anthropic.com/v1/models",
    remainingPath: "",
    usedPath: "",
    totalPath: "",
    unitPath: "",
    scale: "1",
  },
] as const
const EMPTY_PRESENTATION: WhaleBalancePresentation = {
  showBalance: true,
  showApiUsed: true,
  showObservedToday: false,
  showTokenCost: false,
  widgetSize: 44,
}

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
  const [models, setModels] = useState<WhaleBalanceModelView[]>([])
  const [modelDrafts, setModelDrafts] = useState<
    Record<
      string,
      {
        accountName: string
        url: string
        method: string
        authHeader: string
        apiKeyInput: string
        clearApiKey: boolean
        remainingPath: string
        usedPath: string
        totalPath: string
        unitPath: string
        scale: string
      }
    >
  >({})
  const [activeModelId, setActiveModelId] = useState("default")
  const [peakPrice, setPeakPrice] = useState("")
  const [offPeakPrice, setOffPeakPrice] = useState("")
  const [currency, setCurrency] = useState("CNY")
  const [presentation, setPresentation] = useState(EMPTY_PRESENTATION)
  const [adjustmentAmount, setAdjustmentAmount] = useState("")
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
  const [totalPath, setTotalPath] = useState("")
  const [unitPath, setUnitPath] = useState("")
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
    const nextModels = view.models ?? [
      {
        id: "default",
        accountName: view.accountName,
        url: view.url,
        method: view.method,
        authHeader: view.authHeader,
        hasApiKey: view.hasApiKey,
        apiKeyHint: view.apiKeyHint,
        remainingPath: view.remainingPath,
        usedPath: view.usedPath,
        totalPath: view.totalPath ?? "",
        unitPath: view.unitPath ?? "",
        scale: view.scale,
      },
    ]
    setModels(nextModels)
    setModelDrafts({})
    setActiveModelId(view.activeModelId ?? nextModels[0]?.id ?? "default")
    setPeakPrice(view.peakPrice == null ? "" : String(view.peakPrice))
    setOffPeakPrice(view.offPeakPrice == null ? "" : String(view.offPeakPrice))
    setCurrency(view.currency || "CNY")
    setEnabled(view.enabled)
    setAccountName(view.accountName)
    setUrl(view.url)
    setMethod(view.method || DEFAULT_METHOD)
    setAuthHeader(view.authHeader || DEFAULT_AUTH_HEADER)
    setApiKeyInput("")
    setClearApiKey(false)
    setRemainingPath(view.remainingPath || DEFAULT_REMAINING_PATH)
    setUsedPath(view.usedPath ?? "")
    setTotalPath(view.totalPath ?? "")
    setUnitPath(view.unitPath ?? "")
    setScale(String(view.scale ?? 1))
    setPollIntervalSecs(String(view.pollIntervalSecs ?? 60))
  }, [])

  useEffect(() => {
    let cancelled = false
    void getWhaleBalancePresentation()
      .then((value) => setPresentation(value))
      .catch(() => {})
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
        models: models.map((model) => {
          const draft = modelDrafts[model.id]
          const current = model.id === activeModelId
          const modelScale = Number(
            draft?.scale ?? (current ? scale : model.scale)
          )
          return {
            id: model.id,
            accountName:
              draft?.accountName ??
              (current ? accountName.trim() : model.accountName),
            url: draft?.url ?? (current ? url.trim() : model.url),
            method: draft?.method ?? (current ? method : model.method),
            authHeader:
              draft?.authHeader ??
              (current ? authHeader.trim() : model.authHeader),
            apiKey: draft?.apiKeyInput || (current ? trimmedKey : "") || null,
            clearApiKey: draft?.clearApiKey ?? (current && clearApiKey),
            remainingPath:
              draft?.remainingPath ??
              (current ? remainingPath.trim() : model.remainingPath),
            usedPath:
              draft?.usedPath ?? (current ? usedPath.trim() : model.usedPath),
            totalPath:
              draft?.totalPath ??
              (current ? totalPath.trim() : model.totalPath),
            unitPath:
              draft?.unitPath ?? (current ? unitPath.trim() : model.unitPath),
            scale:
              Number.isFinite(modelScale) && modelScale > 0
                ? modelScale
                : model.scale,
          }
        }),
        activeModelId,
        peakPrice: peakPrice.trim() ? Number(peakPrice) : null,
        clearPeakPrice: !peakPrice.trim(),
        offPeakPrice: offPeakPrice.trim() ? Number(offPeakPrice) : null,
        clearOffPeakPrice: !offPeakPrice.trim(),
        currency,
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
      models,
      modelDrafts,
      activeModelId,
      peakPrice,
      offPeakPrice,
      currency,
      pollIntervalSecs,
      remainingPath,
      scale,
      url,
      usedPath,
      totalPath,
      unitPath,
    ]
  )

  // 开关只改动启用状态：用已持久化的视图构造载荷，避免把未保存的草稿一并落库。
  const payloadFromSaved = useCallback(
    (next: boolean): UpdateWhaleBalanceSettingsInput | null => {
      if (!savedView) return null
      return {
        enabled: next,
        accountName: savedView.accountName,
        url: savedView.url,
        method: savedView.method,
        authHeader: savedView.authHeader,
        apiKey: null,
        clearApiKey: false,
        remainingPath: savedView.remainingPath,
        usedPath: savedView.usedPath,
        totalPath: savedView.totalPath ?? "",
        unitPath: savedView.unitPath ?? "",
        scale: savedView.scale,
        models: savedView.models?.map((model) => ({
          id: model.id,
          accountName: model.accountName,
          url: model.url,
          method: model.method,
          authHeader: model.authHeader,
          apiKey: null,
          clearApiKey: false,
          remainingPath: model.remainingPath,
          usedPath: model.usedPath,
          totalPath: model.totalPath ?? "",
          unitPath: model.unitPath ?? "",
          scale: model.scale,
        })),
        activeModelId: savedView.activeModelId,
        peakPrice: savedView.peakPrice ?? null,
        clearPeakPrice: savedView.peakPrice == null,
        offPeakPrice: savedView.offPeakPrice ?? null,
        clearOffPeakPrice: savedView.offPeakPrice == null,
        currency: savedView.currency,
        pollIntervalSecs: savedView.pollIntervalSecs,
      }
    },
    [savedView]
  )

  const handleToggleEnabled = useCallback(
    async (next: boolean) => {
      const prev = enabled
      setEnabled(next)
      if (next) {
        setSectionOpen(true)
      }

      const payload = payloadFromSaved(next)
      // 首次启用但尚未配置过接口地址时，仅展开表单等待用户补全并保存，避免空配置落库。
      if (!payload || (next && payload.url.trim().length === 0)) {
        return
      }

      setSaving(true)
      try {
        // 仅切换开关时基于已持久化视图更新，防止把未保存的半成品表单草稿提前提交。
        const updated = await updateWhaleBalanceSettings(payload)
        setSavedView(updated)
        setEnabled(updated.enabled)
      } catch (err) {
        setEnabled(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [enabled, payloadFromSaved, t]
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

  const applyProviderTemplate = (templateId: string) => {
    const template = PROVIDER_TEMPLATES.find((item) => item.id === templateId)
    if (!template) return
    // 模板只改当前表单，不自动写密钥或多模型配置，避免覆盖用户已有独立配置。
    setAccountName(accountName || template.accountName)
    setUrl(template.url)
    setRemainingPath(template.remainingPath)
    setUsedPath(template.usedPath)
    setTotalPath(template.totalPath)
    setUnitPath(template.unitPath)
    setScale(template.scale)
    if (template.id === "anthropic")
      setAuthHeader("x-api-key:{key};anthropic-version:2023-06-01")
    else setAuthHeader(DEFAULT_AUTH_HEADER)
  }

  const selectModel = (modelId: string) => {
    const model = models.find((entry) => entry.id === modelId)
    if (!model) return
    setModelDrafts((previous) => ({
      ...previous,
      [activeModelId]: {
        accountName,
        url,
        method,
        authHeader,
        apiKeyInput,
        clearApiKey,
        remainingPath,
        usedPath,
        totalPath,
        unitPath,
        scale,
      },
    }))
    const draft = modelDrafts[modelId]
    setActiveModelId(modelId)
    setAccountName(draft?.accountName ?? model.accountName)
    setUrl(draft?.url ?? model.url)
    setMethod(draft?.method ?? model.method ?? DEFAULT_METHOD)
    setAuthHeader(draft?.authHeader ?? model.authHeader ?? DEFAULT_AUTH_HEADER)
    setApiKeyInput(draft?.apiKeyInput ?? "")
    setClearApiKey(draft?.clearApiKey ?? false)
    setRemainingPath(
      draft?.remainingPath ?? model.remainingPath ?? DEFAULT_REMAINING_PATH
    )
    setUsedPath(draft?.usedPath ?? model.usedPath ?? "")
    setTotalPath(draft?.totalPath ?? model.totalPath ?? "")
    setUnitPath(draft?.unitPath ?? model.unitPath ?? "")
    setScale(draft?.scale ?? String(model.scale ?? 1))
    setSavedView((previous) =>
      previous
        ? {
            ...previous,
            accountName: model.accountName,
            url: model.url,
            method: model.method,
            authHeader: model.authHeader,
            hasApiKey: model.hasApiKey,
            apiKeyHint: model.apiKeyHint,
            remainingPath: model.remainingPath,
            usedPath: model.usedPath,
            totalPath: model.totalPath,
            unitPath: model.unitPath,
            scale: model.scale,
          }
        : previous
    )
  }

  const addModel = () => {
    const id = `model-${Date.now().toString(36)}`
    const model: WhaleBalanceModelView = {
      id,
      accountName: "",
      url: "",
      method: DEFAULT_METHOD,
      authHeader: DEFAULT_AUTH_HEADER,
      hasApiKey: false,
      apiKeyHint: null,
      remainingPath: DEFAULT_REMAINING_PATH,
      usedPath: DEFAULT_USED_PATH,
      totalPath: "",
      unitPath: "",
      scale: 1,
    }
    setModelDrafts((previous) => ({
      ...previous,
      [activeModelId]: {
        accountName,
        url,
        method,
        authHeader,
        apiKeyInput,
        clearApiKey,
        remainingPath,
        usedPath,
        totalPath,
        unitPath,
        scale,
      },
      [id]: {
        accountName: "",
        url: "",
        method: DEFAULT_METHOD,
        authHeader: DEFAULT_AUTH_HEADER,
        apiKeyInput: "",
        clearApiKey: false,
        remainingPath: DEFAULT_REMAINING_PATH,
        usedPath: DEFAULT_USED_PATH,
        totalPath: "",
        unitPath: "",
        scale: DEFAULT_SCALE,
      },
    }))
    setModels((previous) => [...previous, model])
    setActiveModelId(id)
    setAccountName("")
    setUrl("")
    setMethod(DEFAULT_METHOD)
    setAuthHeader(DEFAULT_AUTH_HEADER)
    setApiKeyInput("")
    setClearApiKey(false)
    setRemainingPath(DEFAULT_REMAINING_PATH)
    setUsedPath(DEFAULT_USED_PATH)
    setTotalPath("")
    setUnitPath("")
    setScale(DEFAULT_SCALE)
    setSavedView((previous) =>
      previous
        ? {
            ...previous,
            models: [...(previous.models ?? []), model],
            activeModelId: id,
            accountName: "",
            url: "",
            hasApiKey: false,
            apiKeyHint: null,
            remainingPath: model.remainingPath,
            usedPath: model.usedPath,
            totalPath: "",
            unitPath: "",
            scale: 1,
          }
        : previous
    )
  }

  const removeActiveModel = () => {
    if (models.length <= 1) return
    const nextModels = models.filter((model) => model.id !== activeModelId)
    setModels(nextModels)
    // 同步已保存视图：否则仅切换开关时会把刚删掉的模型重新提上去。
    setSavedView((previous) =>
      previous
        ? {
            ...previous,
            models: previous.models?.filter(
              (model) => model.id !== activeModelId
            ),
          }
        : previous
    )
    selectModel(nextModels[0].id)
  }

  const savePresentation = async (next: WhaleBalancePresentation) => {
    setPresentation(await saveWhaleBalancePresentation(next))
  }

  const handleReconcile = async () => {
    const amount = Number(adjustmentAmount)
    if (!Number.isFinite(amount) || amount === 0) return
    try {
      await reconcileWhaleBalance({ modelId: activeModelId, amount })
      setAdjustmentAmount("")
      toast.success(t("reconcileSuccess"))
    } catch (err) {
      toast.error(t("saveFailed", { message: toErrorMessage(err) }))
    }
  }

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
            title={t("modelsLabel")}
            description={t("modelsDescription")}
            htmlFor="whale-model-select"
          >
            <div className="flex gap-2">
              <Select
                value={activeModelId}
                onValueChange={selectModel}
                disabled={saving || models.length === 0}
              >
                <SelectTrigger
                  id="whale-model-select"
                  className="bg-background text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.accountName || model.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addModel}
                disabled={saving}
              >
                <Plus className="size-3.5" />
                {t("addModel")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={removeActiveModel}
                disabled={saving || models.length <= 1}
                aria-label={t("removeModel")}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </SettingRow>
          <SettingRow
            title={t("providerTemplateLabel")}
            description={t("providerTemplateDescription")}
            htmlFor="whale-provider-template"
          >
            <Select
              value=""
              onValueChange={(value) => {
                if (value) applyProviderTemplate(value)
              }}
              disabled={saving}
            >
              <SelectTrigger
                id="whale-provider-template"
                className="w-56 bg-background text-xs"
              >
                <SelectValue placeholder={t("providerTemplatePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TEMPLATES.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
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
            title={t("optionalPathsLabel")}
            description={t("optionalPathsDescription")}
            htmlFor="whale-total-path"
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="whale-total-path"
                  className="text-2xs text-muted-foreground"
                >
                  {t("totalPathLabel")}
                </label>
                <Input
                  id="whale-total-path"
                  value={totalPath}
                  onChange={(event) => setTotalPath(event.target.value)}
                  disabled={saving}
                  className="h-8 bg-background font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="whale-unit-path"
                  className="text-2xs text-muted-foreground"
                >
                  {t("unitPathLabel")}
                </label>
                <Input
                  id="whale-unit-path"
                  value={unitPath}
                  onChange={(event) => setUnitPath(event.target.value)}
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

          <SettingRow
            title={t("pricingLabel")}
            description={t("pricingDescription")}
            htmlFor="whale-peak-price"
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input
                id="whale-peak-price"
                type="number"
                min="0"
                step="any"
                aria-label={t("peakPriceLabel")}
                value={peakPrice}
                onChange={(event) => setPeakPrice(event.target.value)}
                placeholder={t("peakPriceLabel")}
                disabled={saving}
                className="h-8 bg-background font-mono text-xs"
              />
              <Input
                type="number"
                min="0"
                step="any"
                aria-label={t("offPeakPriceLabel")}
                value={offPeakPrice}
                onChange={(event) => setOffPeakPrice(event.target.value)}
                placeholder={t("offPeakPriceLabel")}
                disabled={saving}
                className="h-8 bg-background font-mono text-xs"
              />
              <Input
                aria-label={t("currencyLabel")}
                value={currency}
                onChange={(event) =>
                  setCurrency(event.target.value.toUpperCase())
                }
                placeholder={t("currencyLabel")}
                maxLength={3}
                disabled={saving}
                className="h-8 bg-background font-mono text-xs"
              />
            </div>
          </SettingRow>

          <SettingRow
            title={t("presentationLabel")}
            description={t("presentationDescription")}
            htmlFor="whale-show-balance"
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  ["showBalance", "whale-show-balance", "showBalanceLabel"],
                  ["showApiUsed", "whale-show-api-used", "showApiUsedLabel"],
                  [
                    "showObservedToday",
                    "whale-show-observed",
                    "showObservedTodayLabel",
                  ],
                  [
                    "showTokenCost",
                    "whale-show-token-cost",
                    "showTokenCostLabel",
                  ],
                ] as const
              ).map(([key, id, label]) => (
                <label
                  key={key}
                  htmlFor={id}
                  className="flex items-center gap-2 text-xs"
                >
                  <Switch
                    id={id}
                    checked={presentation[key]}
                    onCheckedChange={(checked) =>
                      void savePresentation({ ...presentation, [key]: checked })
                    }
                  />
                  {t(label)}
                </label>
              ))}
              <label htmlFor="whale-widget-size" className="text-xs">
                {t("widgetSizeLabel")}
                <Input
                  id="whale-widget-size"
                  type="number"
                  min="32"
                  max="96"
                  value={presentation.widgetSize}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setPresentation({
                      ...presentation,
                      // 清空或非数字时保留旧值，避免把 0/NaN 发给后端。
                      widgetSize: Number.isFinite(next)
                        ? Math.max(32, Math.min(96, next))
                        : presentation.widgetSize,
                    })
                  }}
                  onBlur={() => void savePresentation(presentation)}
                  className="mt-1 h-8 bg-background font-mono text-xs"
                />
              </label>
            </div>
          </SettingRow>

          <SettingRow
            title={t("reconcileLabel")}
            description={t("reconcileDescription")}
            htmlFor="whale-reconcile-amount"
          >
            <div className="flex gap-2">
              <Input
                id="whale-reconcile-amount"
                type="number"
                step="any"
                value={adjustmentAmount}
                onChange={(event) => setAdjustmentAmount(event.target.value)}
                placeholder={t("reconcilePlaceholder")}
                disabled={saving}
                className="h-8 bg-background font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving || !adjustmentAmount.trim()}
                onClick={() => void handleReconcile()}
              >
                {t("reconcileButton")}
              </Button>
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
