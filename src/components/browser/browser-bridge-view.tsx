"use client"

import { useEffect, useState } from "react"
import { Copy, ExternalLink, Loader2, RotateCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import {
  bridgeClose,
  bridgeEntryUrl,
  bridgeOpen,
  bridgeOrigin,
  fragmentOf,
  isBridgeableUrl,
  probeBridge,
  type BridgeGrant,
} from "@/lib/browser/browser-bridge"
import { isBlankPageUrl } from "@/lib/browser/browser-url"
import { getBrowserTabState } from "@/lib/browser/browser-tab-store"
import { browserTabBackendId } from "@/lib/file-tab-id"
import { openExternalTab } from "@/lib/link-open"
import { copyTextToClipboard, randomUUID } from "@/lib/utils"

import { BrowserDeviceMenu } from "./browser-device-menu"
import { useBrowserTabCustomSize } from "./browser-device-size"
import { BrowserDeviceStage } from "./browser-device-stage"
import { ICON_BTN } from "./browser-toolbar-buttons"
import { BrowserWebSurface } from "./browser-web-surface"

/** The frame keeps its origin (this target's own, shared with nothing) and
 *  never navigates the workbench. */
export const BRIDGE_FRAME_SANDBOX =
  "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"

type Phase =
  | { kind: "opening" }
  | { kind: "blank" }
  | { kind: "online" }
  | { kind: "ready"; grant: BridgeGrant; src: string }
  | { kind: "unreachable"; grant: BridgeGrant; origin: string; src: string }
  | { kind: "error"; message: string }

function normalizeBridgeAddress(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (/^(javascript|data|file|vbscript):/i.test(text)) return null
  const candidate = /^https?:\/\//i.test(text)
    ? text
    : /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(text)
      ? `http://${text}`
      : `https://${text}`
  try {
    const parsed = new URL(candidate)
    return ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
      ? parsed.toString()
      : null
  } catch {
    return null
  }
}

function usesOnlineBrowser(url: string): boolean {
  return (
    Boolean(process.env.NEXT_PUBLIC_CODEG_BROWSER_URL) || !isBridgeableUrl(url)
  )
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return String(error)
}

/**
 * The web-mode body of a browser tab: a dev server on the codeg host shown
 * through the port bridge in an iframe. Each attempt (a mount, a reload, a
 * new address) takes a fresh grant under a hold id of its own and releases
 * exactly that hold when it is over — after the open has settled, so an
 * unmount during the round trip cannot leave a hold behind or take a later
 * attempt's away. The bridge origin is probed from this browser before the
 * frame shows, so one it cannot reach is explained instead of left blank.
 * "Open in a new tab" stays available throughout: whatever the frame cannot
 * show, a top-level tab on the same bridge origin can.
 */
export function BrowserBridgeView({ tab }: { tab: BrowserWorkspaceTab }) {
  const t = useTranslations("Browser.bridge")
  const [url, setUrl] = useState(
    () => getBrowserTabState(tab.id)?.url || tab.browser.initialUrl
  )
  const [draft, setDraft] = useState(isBlankPageUrl(url) ? "" : url)
  const tabId = browserTabBackendId(tab.id) ?? tab.id
  const setCustomSize = useBrowserTabCustomSize(tab.id)
  const [attempt, setAttempt] = useState(0)
  // The outcome is stamped with the attempt it belongs to; a new attempt
  // (a reload, another address) reads as "opening" until its own outcome
  // lands, without a synchronous reset in the effect.
  const [outcome, setOutcome] = useState<{
    attempt: number
    url: string
    phase: Phase
  } | null>(null)
  const phase: Phase = isBlankPageUrl(url)
    ? { kind: "blank" }
    : usesOnlineBrowser(url)
      ? { kind: "online" }
      : outcome && outcome.attempt === attempt && outcome.url === url
        ? outcome.phase
        : { kind: "opening" }

  useEffect(() => {
    let cancelled = false
    const settle = (phase: Phase) => {
      if (!cancelled) setOutcome({ attempt, url, phase })
    }
    // 空白标签不需要向服务器申请桥接授权，地址栏提交后才开始连接。
    if (isBlankPageUrl(url)) {
      settle({ kind: "blank" })
      return
    }
    // 公网网站由真实浏览器加载，保留原始站点的安全边界和登录态。
    if (usesOnlineBrowser(url)) {
      settle({ kind: "online" })
      return
    }
    // `randomUUID` from utils: `crypto.randomUUID` is missing in a
    // non-secure context, which is where web mode over a LAN address runs.
    const holdId = `${tabId}:${randomUUID()}`
    const opening = bridgeOpen(url, holdId)
    void (async () => {
      let grant: BridgeGrant
      try {
        grant = await opening
      } catch (error) {
        settle({ kind: "error", message: messageOf(error) })
        return
      }
      const page = window.location
      const origin = bridgeOrigin(grant, page)
      const src = bridgeEntryUrl(grant, page, fragmentOf(url))
      const reachable = await probeBridge(origin)
      settle(
        reachable
          ? { kind: "ready", grant, src }
          : { kind: "unreachable", grant, origin, src }
      )
    })()
    return () => {
      cancelled = true
      // Release this attempt's hold once its open has settled — on
      // rejection too: a lost response or a timeout does not say whether
      // the server recorded the hold, and releasing an unknown id is a
      // no-op there. The listener closes a minute later unless another
      // tab uses it; coming back mints a new grant and reloads.
      const release = () => bridgeClose(holdId).catch(() => {})
      void opening.then(release, release)
    }
  }, [url, tabId, attempt])

  const src =
    phase.kind === "ready" || phase.kind === "unreachable" ? phase.src : null

  const copyAddress = async () => {
    const ok = await copyTextToClipboard(url)
    if (ok) toast.success(t("copied"))
  }

  const submitAddress = () => {
    const next = normalizeBridgeAddress(draft)
    if (!next) return
    setDraft(next)
    setUrl(next)
    if (next === url) setAttempt((value) => value + 1)
  }

  return (
    // Marked for the device menu, as the desktop view is.
    <div data-browser-tab-view="" className="flex h-full min-h-0 flex-col">
      {phase.kind !== "online" && (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 px-2 text-xs">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submitAddress()
              }
            }}
            onFocus={(event) => event.currentTarget.select()}
            placeholder={t("addressPlaceholder")}
            aria-label={t("address")}
            title={url}
            autoFocus={isBlankPageUrl(url)}
            className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1 text-xs text-foreground outline-none focus:border-border focus:bg-background"
          />
          <BrowserDeviceMenu tab={tab} />
          <button
            type="button"
            className={ICON_BTN}
            onClick={() => setAttempt((value) => value + 1)}
            title={t("reload")}
            aria-label={t("reload")}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={ICON_BTN}
            disabled={src === null}
            onClick={() => {
              if (src) openExternalTab(src)
            }}
            title={t("openExternal")}
            aria-label={t("openExternal")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={ICON_BTN}
            onClick={() => void copyAddress()}
            title={t("copyAddress")}
            aria-label={t("copyAddress")}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {phase.kind === "opening" ? (
          <div
            role="status"
            className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("opening")}
          </div>
        ) : null}
        {phase.kind === "online" ? (
          <BrowserWebSurface tab={tab} url={url} onNavigate={setUrl} />
        ) : null}
        {phase.kind === "blank" ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("blankHint")}
          </div>
        ) : null}
        {phase.kind === "ready" ? (
          <BrowserDeviceStage
            device={tab.browser.device ?? "desktop"}
            onCustomSize={setCustomSize}
            // Scaled by a transform, which goes as small as it has to: the
            // page is at the device's own size however small the frame.
            minZoom={0}
          >
            {({ viewport, frame }) => (
              <iframe
                key={phase.src}
                title={t("frameTitle")}
                src={phase.src}
                sandbox={BRIDGE_FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                className="absolute top-0 left-0 h-full w-full border-0 bg-white"
                // A device's page is laid out in the device's viewport — a
                // frame element's own size — and shrunk whole to the frame
                // around it: a transform scales what is drawn, not the
                // viewport the document inside sees.
                style={
                  viewport && frame
                    ? {
                        width: viewport.width,
                        height: viewport.height,
                        transform: `scale(${frame.width / viewport.width}, ${frame.height / viewport.height})`,
                        transformOrigin: "0 0",
                      }
                    : undefined
                }
              />
            )}
          </BrowserDeviceStage>
        ) : null}
        {phase.kind === "unreachable" ? (
          <Notice
            title={t("unreachableTitle")}
            // Two ways of reaching the bridge, two things to check: a port
            // the deployment has to publish, or a hostname its DNS and its
            // proxy have to carry.
            body={t(
              phase.grant.bridgeHost
                ? "unreachableHostHint"
                : "unreachableHint",
              { origin: phase.origin }
            )}
            action={{
              label: t("openExternal"),
              onClick: () => openExternalTab(phase.src),
            }}
          />
        ) : null}
        {phase.kind === "error" ? (
          <Notice title={t("errorTitle")} body={phase.message} />
        ) : null}
      </div>
    </div>
  )
}

function Notice({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
      {action ? (
        <button
          type="button"
          className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground hover:bg-primary/8"
          onClick={action.onClick}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {action.label}
        </button>
      ) : null}
    </div>
  )
}
