import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react"
import {
  ArrowLeftRight,
  Menu as MenuIcon,
  RefreshCw,
  Settings,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

import {
  getWhaleBalancePresentation,
  getWhaleBalanceState,
  openSettingsWindow,
  refreshWhaleBalance,
  saveWhaleBalancePresentation,
  subscribeWhaleBalancePresentation,
  subscribeWhaleBalanceUpdated,
} from "@/lib/api"
import { getTransport } from "@/lib/transport"
import type {
  WhaleBalancePresentation,
  WhaleBalanceSnapshot,
} from "@/lib/types"
import { useIsMobile } from "@/hooks/use-mobile"
import { useTabActions } from "@/stores/tab-store"
import { cn } from "@/lib/utils"
import type { PetSessionsPayload } from "@/lib/pet/types"
import {
  DEFAULT_SNAP,
  snapWhalePosition,
  weightedIndex,
} from "@/lib/whale-widget"
import { useWhaleOptions } from "./use-whale-options"
import {
  WhaleOptionsDialog,
  useWhaleLabel,
  whaleEventLabel,
} from "./whale-options-dialog"
import { WhaleBubbleContent, playWhaleSound } from "./whale-bubbles"
import { WhaleUsageDialog, useWhaleQuota } from "./whale-usage-dialog"

const LEGACY_WIDGET_COORD_PREF = "codeg-whale-coord-v1"
const WIDGET_COORD_PREF = "codeg-whale-coord-v2"
const WIDGET_MIRROR_PREF = "codeg-whale-mirror-v1"
const WIDGET_SNAP_PREF = "codeg-whale-snap-v1"
// 原版气泡轮廓：与 dsh 的 1026×700 画布完全一致，气泡主线 + 尾巴。
const BUBBLE_BODY_PATH =
  "M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 827 248 Z"
const AVATAR_SIZE = 44
const MIN_AVATAR_SIZE = 26
const MAX_AVATAR_SIZE = 110
const DRAG_THRESHOLD_PX = 5
const BALANCE_REFRESH_INTERVAL_MS = 30_000

interface WidgetPosition {
  x: number
  y: number
}

// 右、下贴边保存为锚点而非像素，窗口或挂件尺寸变化时也不会留下缝隙。
interface WidgetPlacement {
  x: number | null
  y: number | null
}

/**
 * 原版按视口短边算基准尺寸，再乘用户的缩放。我们的「挂件大小」是头像像素高度，
 * 换算成相对默认值 44 的倍率，保持滑块的直观含义。
 */
function computeBaseSize(avatarSize: number): number {
  const scale = avatarSize / AVATAR_SIZE
  if (typeof window === "undefined") return Math.round(250 * scale)
  const shortSide = Math.min(window.innerWidth, window.innerHeight)
  const auto = Math.min(250, shortSide * 0.28)
  return Math.max(122, Math.min(auto * scale, 625))
}

function clampPosition(
  pos: WidgetPlacement,
  limits: WidgetPosition
): WidgetPosition {
  return {
    x: Math.min(Math.max(0, pos.x ?? limits.x), limits.x),
    y: Math.min(Math.max(0, pos.y ?? limits.y), limits.y),
  }
}

function loadSavedPosition(snapEnabled: boolean): WidgetPlacement {
  try {
    const store = window.localStorage
    const raw = store.getItem(WIDGET_COORD_PREF)
    if (raw) {
      const parsed = JSON.parse(raw) as WidgetPlacement
      if (
        (parsed.x === null || Number.isFinite(parsed.x)) &&
        (parsed.y === null || Number.isFinite(parsed.y))
      )
        return parsed
    }
    const legacy = store.getItem(LEGACY_WIDGET_COORD_PREF)
    if (legacy) {
      const parsed = JSON.parse(legacy) as WidgetPosition
      if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        const halfSize = computeBaseSize(AVATAR_SIZE) / 2
        // 旧版只有绝对坐标，靠近右下角且开启吸附时恢复为贴边。
        return {
          x:
            snapEnabled && parsed.x + halfSize >= window.innerWidth * 0.75
              ? null
              : parsed.x,
          y:
            snapEnabled && parsed.y + halfSize >= window.innerHeight * 0.75
              ? null
              : parsed.y,
        }
      }
    }
  } catch {}
  return { x: null, y: null }
}

function savePosition(pos: WidgetPlacement): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(WIDGET_COORD_PREF, JSON.stringify(pos))
  } catch {}
}

function readBoolPref(key: string): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(key) === "true"
  } catch {
    return false
  }
}

function writeBoolPref(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {}
}

function formatAmount(value: number): string {
  const safe = Math.abs(value) < 0.005 ? 0 : value
  return safe.toFixed(2)
}

function formatUpdatedTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function emptySubscribe(): () => void {
  return () => {}
}

const PRESENTATION_TOGGLES = [
  "showBalance",
  "showApiUsed",
  "showObservedToday",
  "showTokenCost",
] as const

export function WhaleBalanceWidget() {
  const t = useTranslations("WhaleBalanceWidget")
  const ts = useTranslations("WhaleBalanceSettings")
  const isMobile = useIsMobile()
  const { openTab } = useTabActions()
  const hydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )

  const [snapshot, setSnapshot] = useState<WhaleBalanceSnapshot | null>(null)
  const [presentation, setPresentation] = useState<WhaleBalancePresentation>({
    showBalance: true,
    showApiUsed: true,
    showObservedToday: false,
    showTokenCost: false,
    widgetSize: AVATAR_SIZE,
  })
  const [mirror, setMirror] = useState(() => readBoolPref(WIDGET_MIRROR_PREF))
  const [snapEnabled, setSnapEnabled] = useState(
    () => !readBoolPref(`${WIDGET_SNAP_PREF}-off`)
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeSessions, setActiveSessions] =
    useState<PetSessionsPayload | null>(null)
  const [refreshingLocal, setRefreshingLocal] = useState(false)
  const label = useWhaleLabel()
  const { options, loaded, notice, dismiss, save } = useWhaleOptions(
    snapshot,
    activeSessions
  )
  const [dialog, setDialog] = useState<"options" | "usage" | null>(null)
  const [bubbleIndex, setBubbleIndex] = useState(-1)
  const [variant, setVariant] = useState(0)
  const [bubbleRevision, setBubbleRevision] = useState(0)
  const lastVariant = useRef<Record<number, number>>({})
  const longPress = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clearLongPress = () => clearTimeout(longPress.current)
  useEffect(() => () => clearTimeout(longPress.current), [])
  const quota = useWhaleQuota(
    snapshot?.enabled
      ? options.quotas?.[snapshot.modelId ?? "default"]
      : undefined,
    snapshot?.lastSuccessAt
  )

  const [expandedByMode, setExpandedByMode] = useState({
    desktop: true,
    mobile: false,
  })
  const avatarSize = Math.max(
    MIN_AVATAR_SIZE,
    Math.min(MAX_AVATAR_SIZE, presentation.widgetSize)
  )
  const [baseSize, setBaseSize] = useState(() => computeBaseSize(avatarSize))
  const [position, setPosition] = useState(() => loadSavedPosition(snapEnabled))
  const [dragging, setDragging] = useState(false)
  const [pressed, setPressed] = useState(false)

  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: WidgetPosition
    limits: WidgetPosition
    moved: boolean
  } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const suppressNextClickRef = useRef(false)
  const refreshInProgressRef = useRef(false)

  const expanded = isMobile ? expandedByMode.mobile : expandedByMode.desktop
  const toggleExpanded = useCallback(() => {
    setExpandedByMode((prev) =>
      isMobile
        ? { ...prev, mobile: !prev.mobile }
        : { ...prev, desktop: !prev.desktop }
    )
  }, [isMobile])

  useEffect(() => {
    void getWhaleBalancePresentation()
      .then((value) => setPresentation(value))
      .catch(() => {})
    void Promise.resolve(
      getTransport().call<PetSessionsPayload>("pet_list_active_sessions")
    )
      .then((value) => setActiveSessions(value))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const handleResize = () => setBaseSize(computeBaseSize(avatarSize))
    handleResize()
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [avatarSize])

  useEffect(() => {
    let cancelled = false
    let unsubEvent: (() => void) | undefined
    let unsubReconnect: (() => void) | undefined

    const loadState = () => {
      getWhaleBalanceState()
        .then((next) => {
          if (!cancelled) setSnapshot(next)
        })
        .catch(() => {})
    }

    loadState()

    void subscribeWhaleBalanceUpdated((next) => {
      if (!cancelled) setSnapshot(next)
    })
      .then((unsub) => {
        if (cancelled) {
          unsub()
        } else {
          unsubEvent = unsub
        }
      })
      .catch(() => {})

    let unsubPresentation: (() => void) | undefined
    let unsubSessions: (() => void) | undefined
    void Promise.resolve(
      getTransport().subscribe<PetSessionsPayload>("pet://sessions", (next) => {
        if (!cancelled) setActiveSessions(next)
      })
    )
      .then((unsub) => {
        if (cancelled) unsub()
        else unsubSessions = unsub
      })
      .catch(() => {})

    void subscribeWhaleBalancePresentation((next) => {
      if (!cancelled) setPresentation(next)
    })
      .then((unsub) => {
        if (cancelled) unsub()
        else unsubPresentation = unsub
      })
      .catch(() => {})

    const transport = getTransport()
    if (transport.onReconnect) {
      unsubReconnect = transport.onReconnect(loadState)
    }

    return () => {
      cancelled = true
      unsubEvent?.()
      unsubPresentation?.()
      unsubSessions?.()
      unsubReconnect?.()
    }
  }, [])

  // 菜单：点空白处或按 Esc 收起。
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [menuOpen])

  const persistPresentation = useCallback((next: WhaleBalancePresentation) => {
    setPresentation(next)
    void saveWhaleBalancePresentation(next)
      .then((saved) => setPresentation(saved))
      .catch(() => {})
  }, [])

  const handleAvatarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") return
      const bounds = rootRef.current?.parentElement
      if (!bounds) return
      const limits = {
        x: Math.max(0, bounds.clientWidth - baseSize),
        y: Math.max(0, bounds.clientHeight - baseSize),
      }
      const pointerId = event.pointerId ?? 0
      suppressNextClickRef.current = false
      dragStateRef.current = {
        pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: clampPosition(position, limits),
        limits,
        moved: false,
      }
      event.currentTarget.setPointerCapture?.(pointerId)
      setPressed(true)
      const press = options.events?.press
      if (press?.enabled)
        playWhaleSound(options, press.sound, press.volume ?? 100)
      if (options.hideMenu && event.pointerType !== "mouse") {
        clearLongPress()
        longPress.current = setTimeout(() => {
          suppressNextClickRef.current = true
          setMenuOpen(true)
        }, 1500)
      }
    },
    [baseSize, options, position]
  )

  const handleAvatarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const state = dragStateRef.current
      const pointerId = event.pointerId ?? 0
      if (!state || state.pointerId !== pointerId) return
      const dx = event.clientX - state.startX
      const dy = event.clientY - state.startY
      if (!state.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        clearLongPress()
        state.moved = true
        setDragging(true)
      }
      if (state.moved) {
        setPosition(
          clampPosition(
            {
              x: state.origin.x + dx,
              y: state.origin.y + dy,
            },
            state.limits
          )
        )
      }
    },
    []
  )

  const handleAvatarPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const state = dragStateRef.current
      const pointerId = event.pointerId ?? 0
      if (!state || state.pointerId !== pointerId) return
      clearLongPress()
      const press = options.events?.press
      if (press?.enabled)
        playWhaleSound(options, press.release, press.volume ?? 100)
      dragStateRef.current = null
      setDragging(false)
      setPressed(false)
      event.currentTarget.releasePointerCapture?.(pointerId)
      if (state.moved) {
        const released = clampPosition(
          {
            x: state.origin.x + (event.clientX - state.startX),
            y: state.origin.y + (event.clientY - state.startY),
          },
          state.limits
        )
        const snapped = snapEnabled
          ? snapWhalePosition(
              released,
              state.limits,
              baseSize,
              options.snap ?? DEFAULT_SNAP
            )
          : { position: released, mirror }
        setPosition(snapped.position)
        savePosition(snapped.position)
        // 贴左侧时自动镜像，贴右侧时取消镜像。
        if (snapped.mirror !== undefined && snapped.mirror !== mirror) {
          setMirror(snapped.mirror)
          writeBoolPref(WIDGET_MIRROR_PREF, snapped.mirror)
        }
        suppressNextClickRef.current = true
        window.setTimeout(() => {
          suppressNextClickRef.current = false
        }, 0)
      }
    },
    [baseSize, mirror, options, snapEnabled]
  )

  const handleAvatarPointerCancel = useCallback(() => {
    clearLongPress()
    dragStateRef.current = null
    setDragging(false)
    setPressed(false)
  }, [])

  const toggleMirror = useCallback(() => {
    setMirror((previous) => {
      const next = !previous
      writeBoolPref(WIDGET_MIRROR_PREF, next)
      return next
    })
  }, [])

  const toggleSnap = useCallback(() => {
    setSnapEnabled((previous) => {
      const next = !previous
      writeBoolPref(`${WIDGET_SNAP_PREF}-off`, !next)
      return next
    })
  }, [])

  const moveBubble = (index: number) => {
    const choices = options.sequence?.[index]
    if (!choices) {
      setBubbleIndex(-1)
      return
    }
    const selected = weightedIndex(
      choices.map((item) => item.weight),
      Math.random(),
      lastVariant.current[index]
    )
    lastVariant.current[index] = selected
    setVariant(selected)
    setBubbleIndex(index)
    setBubbleRevision((revision) => revision + 1)
  }

  const handleAvatarClick = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }
    if (notice) {
      dismiss()
      return
    }
    if (options.sequence?.length) {
      moveBubble(options.advanceOnAvatar ? bubbleIndex + 1 : 0)
      return
    }
    toggleExpanded()
  }

  const handleRefresh = useCallback(async () => {
    if (refreshInProgressRef.current) return
    refreshInProgressRef.current = true
    setRefreshingLocal(true)
    try {
      const next = await refreshWhaleBalance()
      setSnapshot(next)
    } catch {
    } finally {
      refreshInProgressRef.current = false
      setRefreshingLocal(false)
    }
  }, [])

  useEffect(() => {
    if (!snapshot?.enabled || !snapshot.configured) return
    // 仅在余额已启用且账户已配置时轮询，避免无效请求。
    const interval = window.setInterval(
      () => void handleRefresh(),
      BALANCE_REFRESH_INTERVAL_MS
    )
    return () => window.clearInterval(interval)
  }, [handleRefresh, snapshot?.configured, snapshot?.enabled])

  const handleOpenSettings = useCallback(() => {
    setMenuOpen(false)
    void openSettingsWindow("general").catch((err) => {
      console.error("[WhaleBalanceWidget] open settings failed:", err)
    })
  }, [])

  if (!hydrated || !snapshot || !snapshot.enabled) {
    return null
  }

  const accountTitle = snapshot.accountName.trim()
    ? t("titleWithAccount", { account: snapshot.accountName.trim() })
    : t("titleDefault")

  const balanceText =
    snapshot.balance !== null ? formatAmount(snapshot.balance) : "—"
  const customRows = options.sequence?.[bubbleIndex]?.[variant]?.rows
  const role = options.assets?.find(
    (asset) => asset.id === options.role && asset.data.startsWith("data:image/")
  )
  const activeModelId = snapshot.modelId ?? "default"
  const amount = (value?: number | null) =>
    value == null ? "—" : formatAmount(value)
  const values = {
    account: snapshot.accountName,
    balance: balanceText,
    balance_ds: balanceText,
    used: amount(snapshot.used),
    total:
      snapshot.total === 0
        ? label("不限", "Unlimited")
        : amount(snapshot.total),
    unit: snapshot.unit ?? "",
    today: amount(snapshot.observedToday),
    cost: amount(snapshot.estimatedCostToday),
    peak: snapshot.isPeakPeriod
      ? label("高峰", "Peak")
      : label("低谷", "Off-peak"),
    bonus: "—",
    bonus_ds: "—",
    recharge: "—",
    recharge_ds: "—",
    quota:
      quota?.used == null
        ? "—"
        : `${quota.used.toLocaleString()} / ${quota.total.toLocaleString()}`,
    quota_used: quota?.used?.toLocaleString() ?? "—",
    quota_left:
      quota?.used == null
        ? "—"
        : Math.max(0, quota.total - quota.used).toLocaleString(),
    quota_total: quota?.total.toLocaleString() ?? "—",
    quota_reset: quota?.reset ?? "—",
    session:
      activeSessions?.sessions[0]?.title ??
      label("当前对话", "Current conversation"),
  }

  // 气泡第三行：按用户勾选的字段拼接，缺数据就留空而不是补零。
  const hintParts: string[] = []
  if (presentation.showApiUsed && snapshot.used !== null) {
    hintParts.push(
      t("providerUsedValue", { value: formatAmount(snapshot.used) })
    )
  }
  if (presentation.showObservedToday && snapshot.observedToday != null) {
    hintParts.push(
      t("observedTodayValue", { value: formatAmount(snapshot.observedToday) })
    )
  }
  if (presentation.showTokenCost && snapshot.estimatedCostToday != null) {
    hintParts.push(
      t("tokenCostValue", {
        currency: snapshot.currency ?? "CNY",
        value: formatAmount(snapshot.estimatedCostToday),
      })
    )
  }
  if (quota?.used != null)
    hintParts.push(`${label("额度", "Quota")} ${values.quota}`)

  const isSpinning = refreshingLocal || snapshot.refreshing
  const hasFailure = Boolean(snapshot.lastError) || snapshot.stale

  const statusLine = !snapshot.configured
    ? t("notConfiguredHint")
    : hasFailure && snapshot.lastSuccessAt
      ? t("staleWithTime", { time: formatUpdatedTime(snapshot.lastSuccessAt) })
      : hasFailure
        ? t("fetchFailed")
        : null
  const detailLines = statusLine ? [statusLine] : hintParts

  // 原版以 1026 宽的画布为基准，所有字号都按画布单位缩放。
  const u = baseSize / 1026
  // 多行明细按密度整体收缩，避免把文字压到气泡尾巴。
  const contentScale =
    detailLines.length >= 4
      ? 0.62
      : detailLines.length === 3
        ? 0.72
        : detailLines.length === 2
          ? 0.84
          : 1
  const detailFontSize = Math.max(9, 56 * u * contentScale)
  const eventRows = notice ? options.events?.[notice.kind]?.bubble : undefined
  const bubbleVisible =
    !options.hideBubble &&
    (expanded || !!customRows || !!notice) &&
    (!!notice ||
      !!customRows ||
      presentation.showBalance ||
      detailLines.length > 0)
  const needsAttention = activeSessions?.sessions.find(
    (session) => session.status === "error" || session.status === "prompting"
  )

  const toggleLabels = {
    showBalance: ts("showBalanceLabel"),
    showApiUsed: ts("showApiUsedLabel"),
    showObservedToday: ts("showObservedTodayLabel"),
    showTokenCost: ts("showTokenCostLabel"),
  } as const

  return (
    // 状态栏高 2rem，底边停在状态栏上沿，不挡住状态栏的操作。
    <div
      className="pointer-events-none absolute inset-x-0 top-[env(safe-area-inset-top)] bottom-[calc(2rem+env(safe-area-inset-bottom))] z-40"
      style={options.avoidScrollbar ? { right: 12 } : undefined}
    >
      <div
        ref={rootRef}
        data-testid="whale-balance-widget"
        className="group pointer-events-auto absolute select-none"
        style={{
          ...(position.x === null
            ? { right: 0 }
            : { left: `clamp(0px, ${position.x}px, 100% - ${baseSize}px)` }),
          ...(position.y === null
            ? { bottom: 0 }
            : { top: `clamp(0px, ${position.y}px, 100% - ${baseSize}px)` }),
          width: `${baseSize}px`,
          height: `${baseSize}px`,
          ["--whale-base" as string]: `${baseSize}px`,
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            transformOrigin: "50% 100%",
            transition: "transform .22s cubic-bezier(.34,1.56,.64,1)",
            transform: pressed
              ? mirror
                ? "scaleX(-1) scaleY(.88)"
                : "scaleY(.88) scaleX(1.05)"
              : mirror
                ? "scaleX(-1)"
                : "none",
          }}
        >
          {bubbleVisible && (
            <div
              role="status"
              data-testid="whale-balance-bubble"
              title={snapshot.lastError ?? undefined}
              className="absolute left-0 top-0 w-full"
              style={{
                aspectRatio: "1026 / 700",
                ["--whale-u" as string]: `${u}px`,
              }}
            >
              <svg
                viewBox="0 0 1026 700"
                preserveAspectRatio="xMidYMid meet"
                className="absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
                <path
                  d={BUBBLE_BODY_PATH}
                  fill="#FFFFFF"
                  stroke="#203170"
                  strokeWidth={18}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <ellipse
                  cx="352"
                  cy="561"
                  rx="37.5"
                  ry="26"
                  fill="#FFFFFF"
                  stroke="#203170"
                  strokeWidth={18}
                />
                <ellipse
                  cx="442"
                  cy="646"
                  rx="24.5"
                  ry="18"
                  fill="#FFFFFF"
                  stroke="#203170"
                  strokeWidth={18}
                />
              </svg>

              <div
                data-testid="whale-balance-text"
                className="absolute flex flex-col items-center justify-center text-center"
                style={{
                  left: "44.25%",
                  top: "35.5%",
                  width: "66%",
                  height: "auto",
                  // 镜像时文字要翻回来才可读，与原版一致。
                  transform: `translate(-50%, -50%)${mirror ? " scaleX(-1)" : ""}`,
                  color: "#536ba9",
                  lineHeight: 1.15,
                  whiteSpace: "normal",
                }}
              >
                {notice ? (
                  eventRows?.length ? (
                    <WhaleBubbleContent
                      rows={eventRows}
                      options={options}
                      values={{
                        ...values,
                        ...notice.values,
                        session: notice.values.session ?? values.session,
                        cost: notice.values.cost ?? "—",
                      }}
                    />
                  ) : (
                    <div>
                      {notice.kind === "complete"
                        ? [
                            notice.values.session,
                            notice.values.tokens &&
                              `${notice.values.tokens} tokens`,
                            notice.values.cost,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : notice.kind === "low"
                          ? balanceText
                          : notice.kind === "budget"
                            ? values.today
                            : (notice.values.session ?? values.session)}
                    </div>
                  )
                ) : customRows ? (
                  <WhaleBubbleContent
                    rows={customRows}
                    options={options}
                    values={values}
                    revision={bubbleRevision}
                  />
                ) : (
                  <>
                    {presentation.showBalance && (
                      <>
                        <div
                          data-testid="whale-balance-label"
                          style={{
                            fontSize: 66 * u * contentScale,
                            fontWeight: 600,
                            letterSpacing: "0.06em",
                          }}
                        >
                          {accountTitle}
                        </div>
                        <div
                          data-testid="whale-balance-summary"
                          style={{
                            fontSize: 128 * u * contentScale,
                            fontWeight: 800,
                            lineHeight: 1.05,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {balanceText}
                        </div>
                      </>
                    )}
                    {detailLines.length > 0 ? (
                      <div
                        data-testid="whale-balance-details"
                        className="mt-1 flex max-w-full flex-col items-center"
                        style={{
                          fontSize: detailFontSize,
                          lineHeight: 1.15,
                          gap: Math.max(1, 6 * u),
                          color: "#536ba9",
                        }}
                      >
                        {detailLines.map((line, index) => (
                          <div
                            key={`${index}-${line}`}
                            data-testid={
                              index === 0
                                ? statusLine
                                  ? "whale-balance-stale"
                                  : "whale-balance-hint"
                                : "whale-balance-detail"
                            }
                            className="max-w-full text-center"
                            style={{
                              overflowWrap: "normal",
                              wordBreak: "normal",
                            }}
                          >
                            {line}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              {notice && (
                <button
                  type="button"
                  aria-label={label("关闭泡泡", "Close bubble")}
                  onClick={(event) => {
                    event.stopPropagation()
                    dismiss()
                  }}
                  className="absolute right-[16%] top-[13%] flex size-5 items-center justify-center rounded-full bg-white/85 text-[#203170] shadow-sm"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            aria-label={t("toggleAriaLabel")}
            aria-expanded={!options.hideBubble && (expanded || !!customRows)}
            onClick={handleAvatarClick}
            onContextMenu={(event) => {
              event.preventDefault()
              clearLongPress()
              setMenuOpen(true)
            }}
            onPointerDown={handleAvatarPointerDown}
            onPointerMove={handleAvatarPointerMove}
            onPointerUp={handleAvatarPointerUp}
            onPointerCancel={handleAvatarPointerCancel}
            className={cn(
              "absolute right-0 bottom-0 touch-none border-0 bg-transparent p-0 focus-visible:outline-none",
              dragging ? "cursor-grabbing" : "cursor-grab"
            )}
            style={{ width: "59.45%", height: "59.45%" }}
          >
            <img
              src={role?.data ?? "/images/whale-widget.png"}
              alt={t("avatarAlt")}
              draggable={false}
              className="h-full w-full object-contain object-right-bottom"
            />
          </button>

          {needsAttention && (
            <button
              type="button"
              aria-label={t("sessionAttention")}
              title={t("sessionAttention")}
              onClick={(event) => {
                event.stopPropagation()
                openTab(
                  needsAttention.folderId,
                  needsAttention.conversationId,
                  needsAttention.agentType,
                  false,
                  needsAttention.title
                )
              }}
              className="absolute right-0 top-0 h-3 w-3 rounded-full border-2 border-white bg-red-500 shadow"
            />
          )}

          {hasFailure && !expanded && (
            <span
              aria-hidden="true"
              className="absolute right-0 top-0 h-3 w-3 rounded-full border-2 border-white bg-amber-500"
            />
          )}
        </div>

        {notice && options.hideBubble && (
          <div
            role="status"
            className="fixed top-1/2 left-1/2 z-10 grid w-60 max-w-[calc(100vw-1rem)] -translate-x-1/2 -translate-y-1/2 gap-2 rounded-lg border bg-background p-3 text-sm text-foreground shadow-lg"
          >
            <div className="flex items-start justify-between gap-2">
              <strong>{whaleEventLabel(notice.kind, label)}</strong>
              <button
                type="button"
                aria-label={label("关闭泡泡", "Close bubble")}
                onClick={dismiss}
              >
                <X className="size-4" />
              </button>
            </div>
            {eventRows?.length ? (
              <WhaleBubbleContent
                rows={eventRows}
                options={options}
                values={{
                  ...values,
                  ...notice.values,
                  session: notice.values.session ?? values.session,
                  cost: notice.values.cost ?? "—",
                }}
              />
            ) : (
              <div>
                {notice.kind === "complete"
                  ? [
                      notice.values.session,
                      notice.values.tokens && `${notice.values.tokens} tokens`,
                      notice.values.cost,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : notice.kind === "low"
                    ? balanceText
                    : notice.kind === "budget"
                      ? values.today
                      : (notice.values.session ?? values.session)}
              </div>
            )}
            {notice.conversationId &&
              activeSessions?.sessions.some(
                (item) => item.conversationId === notice.conversationId
              ) && (
                <button
                  type="button"
                  className="justify-self-end text-xs underline"
                  onClick={() => {
                    const session = activeSessions.sessions.find(
                      (item) => item.conversationId === notice.conversationId
                    )
                    if (session)
                      openTab(
                        session.folderId,
                        session.conversationId,
                        session.agentType,
                        false,
                        session.title
                      )
                    dismiss()
                  }}
                >
                  {label("打开对话", "Open conversation")}
                </button>
              )}
          </div>
        )}
        {(!options.hideMenu || menuOpen) && (
          <button
            type="button"
            aria-label={t("menuAria")}
            aria-expanded={menuOpen}
            title={t("menuAria")}
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpen((previous) => !previous)
            }}
            className={cn(
              "absolute flex h-[26px] w-[26px] items-center justify-center rounded-md text-white shadow-md transition-opacity focus-visible:opacity-100",
              menuOpen || isMobile
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100"
            )}
            style={{
              top: "calc(40.55% + 4px)",
              [mirror ? "left" : "right"]: 4,
              background: "rgba(32,49,112,0.85)",
            }}
          >
            {menuOpen ? (
              <X className="size-3.5" />
            ) : (
              <MenuIcon className="size-3.5" />
            )}
          </button>
        )}

        {menuOpen && (
          <div
            data-testid="whale-balance-menu"
            role="menu"
            className="absolute z-50 max-h-[calc(100dvh-4rem)] w-56 overflow-y-auto rounded-xl border border-[#203170]/35 bg-white/95 p-3 text-[11px] text-[#203170] shadow-xl"
            style={{
              bottom: "calc(59.45% + 6px)",
              [mirror ? "left" : "right"]: 0,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide opacity-70">
              <span>{t("menuBubble")}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {snapshot.balance !== null ? balanceText : "—"}
              </span>
            </div>

            <label className="mb-1 block">
              <span className="flex items-center justify-between">
                <span>{ts("widgetSizeLabel")}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {avatarSize}
                </span>
              </span>
              <input
                type="range"
                min={MIN_AVATAR_SIZE}
                max={MAX_AVATAR_SIZE}
                step={4}
                value={avatarSize}
                aria-label={ts("widgetSizeLabel")}
                onChange={(event) =>
                  setPresentation((previous) => ({
                    ...previous,
                    widgetSize: Number(event.target.value),
                  }))
                }
                onPointerUp={() => void persistPresentation(presentation)}
                className="mt-1 w-full accent-[#203170]"
              />
            </label>

            <div className="my-2 border-t border-[#203170]/20" />

            {PRESENTATION_TOGGLES.map((key) => (
              <label
                key={key}
                className="flex cursor-pointer items-center justify-between py-0.5"
              >
                <span>{toggleLabels[key]}</span>
                <input
                  type="checkbox"
                  checked={presentation[key]}
                  aria-label={toggleLabels[key]}
                  onChange={(event) =>
                    persistPresentation({
                      ...presentation,
                      [key]: event.target.checked,
                    })
                  }
                  className="size-3 accent-[#203170]"
                />
              </label>
            ))}

            <div className="my-2 border-t border-[#203170]/20" />

            <label className="flex cursor-pointer items-center justify-between py-0.5">
              <span>{t("menuSnap")}</span>
              <input
                type="checkbox"
                checked={snapEnabled}
                aria-label={t("menuSnap")}
                onChange={toggleSnap}
                className="size-3 accent-[#203170]"
              />
            </label>

            <div className="mt-2 flex gap-1">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  toggleMirror()
                }}
                className="flex flex-1 items-center justify-center gap-1 rounded-md bg-[#203170]/10 py-1 transition-colors hover:bg-[#203170]/20"
              >
                <ArrowLeftRight className="size-3" />
                {t("menuMirror")}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleRefresh()
                }}
                disabled={isSpinning}
                className="flex flex-1 items-center justify-center gap-1 rounded-md bg-[#203170]/10 py-1 transition-colors hover:bg-[#203170]/20 disabled:opacity-60"
              >
                <RefreshCw
                  className={cn("size-3", isSpinning && "animate-spin")}
                />
                {t("menuRefresh")}
              </button>
            </div>

            {loaded && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setDialog("options")
                }}
                className="mt-1 w-full rounded-md bg-[#203170]/10 py-1 hover:bg-[#203170]/20"
              >
                {label("挂件设置", "Widget settings")}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                setDialog("usage")
              }}
              className="mt-1 w-full rounded-md bg-[#203170]/10 py-1 hover:bg-[#203170]/20"
            >
              {label("小鲸鱼记账", "Usage records")}
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                handleOpenSettings()
              }}
              className="mt-1 flex w-full items-center justify-center gap-1 rounded-md bg-[#203170]/10 py-1 transition-colors hover:bg-[#203170]/20"
            >
              <Settings className="size-3" />
              {t("menuSettings")}
            </button>
          </div>
        )}
      </div>
      {dialog === "options" && (
        <WhaleOptionsDialog
          key={activeModelId}
          options={options}
          presentation={presentation}
          onSave={save}
          onSavePresentation={persistPresentation}
          onClose={() => setDialog(null)}
          modelId={activeModelId}
          balanceLabel={snapshot.accountName || activeModelId}
        />
      )}
      {dialog === "usage" && (
        <WhaleUsageDialog snapshot={snapshot} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}
