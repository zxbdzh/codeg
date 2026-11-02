"use client"

/**
 * AI 助手设置页（`/settings/ai-assistant`）。
 *
 * 关键约束（docs/adr/0001）：AI 助手**不另存密钥**——它只在这里选一条既有的
 * AI 提供方，请求时后端直接读那条提供方的 `api_url` / `api_key`。所以本页：
 *
 * - 没有"输入 API key"的控件，也不展示任何密钥明文，只复用提供方记录；
 * - 提供方记录上**没有**协议与密钥头字段（`ModelProviderInfo` 只有
 *   `agent_type` / `api_url` / `api_key` / `model`），所以这两个值只能落在
 *   `AiAssistantSettings` 自身，由本页直接编辑——它们不影响 provider 表；
 * - "测试连接"测的是**已保存**的配置（后端 `test_ai_assistant_connection`
 *   重新读设置再发最小请求），所以保存之前它是禁用的，避免测一份没生效的草稿。
 */

import { useCallback, useEffect, useState } from "react"
import { Loader2, PlugZap, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
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
  getAiAssistantAvailability,
  getAiAssistantSettings,
  listModelProviders,
  testAiAssistantConnection,
  updateAiAssistantSettings,
} from "@/lib/api"
import {
  extractAppCommandError,
  toErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import type {
  AiAssistantAvailability,
  AiAssistantKeyHeader,
  AiAssistantProtocol,
  AiAssistantSettings,
  AiAssistantTitleSource,
  ModelProviderInfo,
} from "@/lib/types"

/** 后端 `MIN_ALLOWED_CONTEXT_TURNS` / `MAX_ALLOWED_CONTEXT_TURNS`。 */
const CONTEXT_TURNS_MIN = 1
const CONTEXT_TURNS_MAX = 50

/** 后端 `MIN_ALLOWED_INTERVAL_SECONDS` / `MAX_ALLOWED_INTERVAL_SECONDS`。 */
const INTERVAL_MIN = 5
const INTERVAL_MAX = 3600

/** 仅保留后端已实现的两种生成协议。协议和密钥头是兼容性设置，
 * 用于复用已有提供方的端点，不新增密钥存储。 */
const PROTOCOL_OPTIONS: AiAssistantProtocol[] = ["openai", "anthropic"]

/** 密钥头的显示名，与后端 `KeyHeader` 的序列化值一致。 */
const KEY_HEADER_LABEL_KEYS: Record<AiAssistantKeyHeader, string> = {
  bearer: "keyHeaderBearer",
  x_api_key: "keyHeaderXApiKey",
  x_goog_api_key: "keyHeaderXGoogApiKey",
}

/** 密钥头的覆盖选项：`null` = 交给协议惯例（OpenAI 用 Bearer，Anthropic 用
 *  x-api-key）。`x_goog_api_key` 只作为既有值保留显示，不新增入口——它属于
 *  Gemini 接线，而本页不提供 Gemini 协议。 */
const KEY_HEADER_OPTIONS: (AiAssistantKeyHeader | null)[] = [
  null,
  "bearer",
  "x_api_key",
]

const TITLE_SOURCES: AiAssistantTitleSource[] = ["codeg", "agent", "fallback"]

const AVAILABILITY_LABEL_KEYS: Record<AiAssistantAvailability, string> = {
  ready: "statusReady",
  no_provider: "statusNoProvider",
  provider_missing: "statusProviderMissing",
  no_model: "statusNoModel",
  unsupported_protocol: "statusUnsupportedProtocol",
}

/** 后端错误 i18n_key 的命名空间前缀（见 `src-tauri/src/commands/ai_assistant.rs`
 *  的 `to_app_error`）。key 是 `aiAssistant.errorUnauthorized` 这种全路径，
 *  而翻译器已经 scope 到 `AiAssistant`，所以要先剥掉前缀再查，否则会把裸 key
 *  当文案显示给用户。 */
const ERROR_KEY_NAMESPACE = "aiAssistant."

/** 后端 i18n_key 在本页文案里的名字。剥掉命名空间；不在映射里的回落英文原句，
 *  因为后端新增一个错误码时不该让页面显示一个 key。 */
function errorMessageKey(i18nKey: string | null): string | null {
  if (!i18nKey?.startsWith(ERROR_KEY_NAMESPACE)) return null
  return i18nKey.slice(ERROR_KEY_NAMESPACE.length)
}

/** 一条后端错误的本地化文案：先走后端给的 i18n_key（剥掉命名空间后查本页的
 * `AiAssistant` 文案），查不到再回落英文 `message`。 */
function aiErrorMessage(error: unknown, t: AppErrorTranslator): string {
  const key = errorMessageKey(extractAppCommandError(error)?.i18n_key ?? null)
  if (key) {
    try {
      const localized = t(key).trim()
      if (localized && localized !== key) return localized
    } catch {
      // 没这条文案时走下面的回落。
    }
  }
  return toErrorMessage(error)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function AiAssistantSettingsSection() {
  const t = useTranslations("AiAssistantSettings")
  const tError = useTranslations("AiAssistant") as unknown as AppErrorTranslator

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [availability, setAvailability] =
    useState<AiAssistantAvailability | null>(null)
  /** 重试计数。改动它就让加载 effect 重跑一次，比重载整页干净——也保住了
   *  本页其余状态（而整页重载会把用户还没保存的草稿一起丢掉）。 */
  const [reloadKey, setReloadKey] = useState(0)

  const [providers, setProviders] = useState<ModelProviderInfo[]>([])
  const [draft, setDraft] = useState<AiAssistantSettings | null>(null)
  /** 已保存的那一份；`null` = 还没保存成功过。测试连接与"未保存"提示都以它为准。 */
  const [saved, setSaved] = useState<AiAssistantSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    // 重试入口：加载失败时唯一能做的事就是把三个读取重跑一遍。`loading` 归
    // 这里管，所以重试期间按钮自己也会禁用。
    const load = () => {
      setLoading(true)
      void Promise.all([
        getAiAssistantSettings(),
        listModelProviders(),
        getAiAssistantAvailability(),
      ])
        .then(([settings, rows, status]) => {
          if (cancelled) return
          setDraft(settings)
          setSaved(settings)
          setProviders(rows)
          setAvailability(status)
          setLoadError(null)
        })
        .catch((err: unknown) => {
          if (!cancelled) setLoadError(toErrorMessage(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    load()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const patch = useCallback((next: Partial<AiAssistantSettings>) => {
    setDraft((current) => (current ? { ...current, ...next } : current))
  }, [])

  /**
   * 协议与密钥头的显示值。后端 `AiAssistantSettings::protocol()` 在字段为
   * `null` 时按 OpenAI 兼容处理，所以这里 `null` 就显示 OpenAI 兼容——显示的
   * 是后端真正会用的那个协议，而不是一片空白。密钥头同理：`null` 表示"按协议
   * 惯例"，OpenAI 用 Bearer、Anthropic 用 x-api-key。
   *
   * 这两个字段存在 `AiAssistantSettings` 自身：提供方记录上没有它们（见文件头），
   * 所以覆盖它们不会也不该改动 provider 表。
   */
  const protocol: AiAssistantProtocol = draft?.protocol ?? "openai"
  const keyHeader: AiAssistantKeyHeader =
    draft?.keyHeader ?? (protocol === "anthropic" ? "x_api_key" : "bearer")

  /**
   * 保存时提交的那一份快照。
   *
   * 请求在飞的时候用户还能继续改草稿（输入框不禁用，`saving` 只是让按钮转圈），
   * 而 `updateAiAssistantSettings` 回的是**服务端**那份。若直接用返回值覆盖
   * 草稿，用户这几秒里敲的字就被静默回退了。因此只在当前草稿仍等于提交前
   * 的快照时采用返回值；若有新编辑，保留整份新草稿并标记为未保存。
   */
  const save = useCallback(async () => {
    if (!draft) return
    setSaving(true)
    // 提交时刻的副本：await 期间 draft 会变，而请求体必须是这一刻看到的值。
    const submitted = {
      ...draft,
      // 后端会再夹一次范围，这里先按同样范围夹，避免把越界值写出去再被弹回来。
      contextTurns: clamp(
        draft.contextTurns,
        CONTEXT_TURNS_MIN,
        CONTEXT_TURNS_MAX
      ),
      titleMinIntervalSeconds: clamp(
        draft.titleMinIntervalSeconds,
        INTERVAL_MIN,
        INTERVAL_MAX
      ),
    }
    try {
      const applied = await updateAiAssistantSettings(submitted)
      setDraft((current) =>
        // 必须比较回调拿到的最新草稿，而不是 await 前闭包中的 draft。
        // 服务端可规范化旧值，但不能吞掉请求期间用户新敲的内容。
        current && JSON.stringify(current) !== JSON.stringify(draft)
          ? current
          : applied
      )
      setSaved(applied)
      window.dispatchEvent(new Event("codeg:ai-settings-changed"))
      const status = await getAiAssistantAvailability()
      setAvailability(status)
      toast.success(t("saved"))
    } catch (err: unknown) {
      toast.error(t("saveFailed"), {
        description: aiErrorMessage(err, tError),
      })
    } finally {
      setSaving(false)
    }
  }, [draft, t, tError])

  const testConnection = useCallback(async () => {
    setTesting(true)
    try {
      await testAiAssistantConnection()
      toast.success(t("testSucceeded"))
    } catch (err: unknown) {
      toast.error(t("testFailed"), {
        description: aiErrorMessage(err, tError),
      })
    } finally {
      setTesting(false)
    }
  }, [t, tError])

  if (loading) {
    return (
      <SettingsSection icon={Sparkles} title={t("title")}>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </SettingsSection>
    )
  }

  // 加载失败：draft 还是 null（拿不到设置，没有东西可编辑），这时必须离开
  // 上面那个 `loading || !draft` 的分支——否则失败也会渲染成永久的转圈。
  // 没有可保存的配置，也就没有保存栏，只说清失败并给一次重试。
  if (!draft) {
    return (
      <SettingsSection icon={Sparkles} title={t("title")}>
        <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
          <p role="alert">{t("loadFailed")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            {t("retry")}
          </Button>
        </div>
      </SettingsSection>
    )
  }

  const dirty =
    saved !== null && JSON.stringify(draft) !== JSON.stringify(saved)

  return (
    <SettingsSection
      icon={Sparkles}
      title={t("title")}
      description={t("description")}
    >
      {loadError && <SettingsError>{t("loadFailed")}</SettingsError>}

      {availability && availability !== "ready" && (
        <SettingsError>
          {t(AVAILABILITY_LABEL_KEYS[availability] as Parameters<typeof t>[0])}
        </SettingsError>
      )}

      <SettingCard>
        <SettingRow
          title={t("provider")}
          description={t("providerHint")}
          control={
            <Select
              value={
                draft.providerId == null ? "__none__" : String(draft.providerId)
              }
              onValueChange={(value) =>
                patch({
                  providerId: value === "__none__" ? null : Number(value),
                })
              }
            >
              <SelectTrigger className="h-8 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("noProvider")}</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          title={t("protocol")}
          description={t("protocolHint")}
          control={
            <Select
              value={protocol}
              onValueChange={(value) =>
                patch({ protocol: value as AiAssistantProtocol })
              }
            >
              <SelectTrigger
                aria-label={t("protocol")}
                className="h-8 w-56 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROTOCOL_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(
                      option === "anthropic"
                        ? "protocolAnthropic"
                        : "protocolOpenai"
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          title={t("keyHeader")}
          description={t("keyHeaderHint")}
          control={
            <Select
              value={draft.keyHeader ?? "__default__"}
              onValueChange={(value) =>
                patch({
                  keyHeader:
                    value === "__default__"
                      ? null
                      : (value as AiAssistantKeyHeader),
                })
              }
            >
              <SelectTrigger
                aria-label={t("keyHeader")}
                className="h-8 w-56 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  {t("keyHeaderDefault")}
                </SelectItem>
                {KEY_HEADER_OPTIONS.map((option) =>
                  option ? (
                    <SelectItem key={option} value={option}>
                      {t(
                        KEY_HEADER_LABEL_KEYS[option] as Parameters<typeof t>[0]
                      )}
                    </SelectItem>
                  ) : null
                )}
                {/* 既有的 x-goog 值只在这里露一面，好让选了它的人看见自己存的
                    是什么；它不是可选项——Gemini 接线不提供，别在这里新增。 */}
                {keyHeader === "x_goog_api_key" && (
                  <SelectItem value="x_goog_api_key">
                    {t(
                      KEY_HEADER_LABEL_KEYS.x_goog_api_key as Parameters<
                        typeof t
                      >[0]
                    )}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          }
        />
      </SettingCard>

      <SettingCard>
        <SettingRow
          title={t("tagModel")}
          description={t("tagModelHint")}
          control={
            <Input
              aria-label={t("tagModel")}
              value={draft.tagModel}
              onChange={(e) => patch({ tagModel: e.target.value })}
              placeholder={t("modelPlaceholder")}
              className="h-8 w-56 text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          }
        />
        <SettingRow
          title={t("titleModel")}
          description={
            draft.titleModel.trim()
              ? t("titleModelHint")
              : t("titleModelFallback")
          }
          control={
            <Input
              aria-label={t("titleModel")}
              value={draft.titleModel}
              onChange={(e) => patch({ titleModel: e.target.value })}
              placeholder={t("modelPlaceholder")}
              className="h-8 w-56 text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          }
        />
      </SettingCard>

      <SettingCard>
        <SettingRow
          title={t("titleSource")}
          description={t("titleSourceHint")}
          control={
            <Select
              value={draft.titleSource}
              onValueChange={(value) =>
                patch({ titleSource: value as AiAssistantTitleSource })
              }
            >
              <SelectTrigger className="h-8 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TITLE_SOURCES.map((source) => (
                  <SelectItem key={source} value={source}>
                    {t(`titleSource_${source}` as Parameters<typeof t>[0])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          title={t("contextTurns")}
          description={t("contextTurnsHint", {
            min: CONTEXT_TURNS_MIN,
            max: CONTEXT_TURNS_MAX,
          })}
          control={
            <Input
              aria-label={t("contextTurns")}
              type="number"
              min={CONTEXT_TURNS_MIN}
              max={CONTEXT_TURNS_MAX}
              value={draft.contextTurns}
              onChange={(e) =>
                patch({
                  contextTurns: clamp(
                    Number(e.target.value),
                    CONTEXT_TURNS_MIN,
                    CONTEXT_TURNS_MAX
                  ),
                })
              }
              className="h-8 w-24 text-xs"
            />
          }
        />
        <SettingRow
          title={t("titleInterval")}
          description={t("titleIntervalHint", {
            min: INTERVAL_MIN,
            max: INTERVAL_MAX,
          })}
          control={
            <Input
              aria-label={t("titleInterval")}
              type="number"
              min={INTERVAL_MIN}
              max={INTERVAL_MAX}
              value={draft.titleMinIntervalSeconds}
              onChange={(e) =>
                patch({
                  titleMinIntervalSeconds: clamp(
                    Number(e.target.value),
                    INTERVAL_MIN,
                    INTERVAL_MAX
                  ),
                })
              }
              className="h-8 w-24 text-xs"
            />
          }
        />
        <SettingRow
          title={t("autoSuggestTags")}
          description={t("autoSuggestTagsHint")}
          control={
            <Switch
              aria-label={t("autoSuggestTags")}
              checked={draft.autoSuggestTags}
              onCheckedChange={(checked) => patch({ autoSuggestTags: checked })}
            />
          }
        />
      </SettingCard>

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void testConnection()}
          // 测试连接用的是已保存配置：后端重新读设置再发请求。有未保存改动时
          // 禁用它，避免"测通了但没保存"这种误导。
          disabled={testing || saving || loading || dirty || !saved}
          title={dirty ? t("testNeedsSave") : undefined}
        >
          {testing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <PlugZap className="size-3.5" />
          )}
          {t("testConnection")}
        </Button>
        <SettingsSaveBar
          onSave={() => void save()}
          saving={saving}
          disabled={loading || !dirty}
          label={t("save")}
          savingLabel={t("saving")}
        />
      </div>
    </SettingsSection>
  )
}
