"use client"

import { useState } from "react"
import { create } from "zustand"
import { Copy } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { copyTextToClipboard } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** 一次失败的标题生成：给用户看的短原因 + 给开发者看的完整诊断文本。 */
export interface TitleFailure {
  /** 可用于一键复制的多行诊断信息（含时间戳与错误码）。 */
  diagnostic: string
  /** 原始错误里拿得到结构化信息时保留，好让界面显示本地化原因。 */
  i18nKey: string | null
  i18nParams: Record<string, string> | null
  message: string
  code: string | null
  detail: string | null
}

const AI_ERROR_NAMESPACE = "aiAssistant."

/**
 * 把一次标题生成失败整理成可读原因与可复制文本。
 *
 * 标题失败多来自提供方（超时、401、模型不存在、没有新内容），这些在用户眼里
 * 都是一句"失败了"；把 code/detail 留下来，用户才能把真实原因发回来。
 */
export function titleFailureOf(
  error: unknown,
  conversationId: number
): TitleFailure {
  const info = extractAppCommandError(error)
  const lines = [
    "codeg title generation failed",
    `conversationId: ${conversationId}`,
    `at: ${new Date().toISOString()}`,
  ]
  if (info) {
    lines.push(`code: ${info.code}`, `message: ${info.message}`)
    if (info.i18n_key) lines.push(`i18n_key: ${info.i18n_key}`)
    if (info.detail) lines.push(`detail: ${info.detail}`)
    if (info.i18n_params) {
      lines.push(`params: ${JSON.stringify(info.i18n_params)}`)
    }
  } else if (error instanceof Error) {
    lines.push(`message: ${error.message}`)
    if (error.stack) {
      lines.push(`stack: ${error.stack.split("\n").slice(0, 5).join("\n")}`)
    }
  } else {
    lines.push(`raw: ${String(error)}`)
  }
  return {
    diagnostic: lines.join("\n"),
    i18nKey: info?.i18n_key ?? null,
    i18nParams: info?.i18n_params ?? null,
    message: toErrorMessage(error),
    code: info?.code ?? null,
    detail: info?.detail ?? null,
  }
}

export function TitleFailureDialog({
  failure,
  onClose,
}: {
  failure: TitleFailure | null
  onClose: () => void
}) {
  const t = useTranslations("AiTagging")
  const tError = useTranslations("AiAssistant")
  const [copied, setCopied] = useState(false)

  // 后端带 i18n_key 时优先用它给出一句本地化的原因，否则回落到原始英文文案。
  let reason = failure?.message ?? ""
  const key = failure?.i18nKey?.startsWith(AI_ERROR_NAMESPACE)
    ? failure.i18nKey.slice(AI_ERROR_NAMESPACE.length)
    : null
  if (key) {
    try {
      const localized = tError(
        key as Parameters<typeof tError>[0],
        (failure?.i18nParams ?? {}) as Parameters<typeof tError>[1]
      ).trim()
      if (localized && localized !== key) reason = localized
    } catch {
      // 没有这条文案时保留原始 message。
    }
  }

  const copy = async () => {
    if (!failure) return
    const ok = await copyTextToClipboard(failure.diagnostic)
    setCopied(ok)
    if (ok) toast.success(t("copied"))
  }

  return (
    <Dialog
      open={failure !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("titleFailed")}</DialogTitle>
          <DialogDescription>{t("titleFailedHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-sm">
          <p className="break-words" data-testid="title-failure-reason">
            {reason}
          </p>
          {failure?.code && (
            <p className="text-xs text-muted-foreground">
              {t("errorCode", { code: failure.code })}
            </p>
          )}
          {failure?.detail && (
            <pre className="max-h-40 overflow-auto rounded border bg-muted/30 p-2 text-xs whitespace-pre-wrap break-all">
              {failure.detail}
            </pre>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
          <Button onClick={() => void copy()}>
            <Copy className="size-4" />
            {copied ? t("copied") : t("copyDetails")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 菜单项所在的 Radix 菜单在选中后会立刻卸载，而失败是异步回来的，
// 所以失败态放在模块级 store 里，由全局 Host 常驻渲染。
const useTitleFailure = create<{ failure: TitleFailure | null }>(() => ({
  failure: null,
}))
export function showTitleFailure(failure: TitleFailure) {
  useTitleFailure.setState({ failure })
}
export function TitleFailureHost() {
  const failure = useTitleFailure((s) => s.failure)
  return (
    <TitleFailureDialog
      failure={failure}
      onClose={() => useTitleFailure.setState({ failure: null })}
    />
  )
}
