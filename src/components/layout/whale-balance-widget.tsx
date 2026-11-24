import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { RefreshCw, Settings } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  getWhaleBalanceState,
  openSettingsWindow,
  refreshWhaleBalance,
  subscribeWhaleBalanceUpdated,
} from "@/lib/api"
import { getTransport } from "@/lib/transport"
import type { WhaleBalanceSnapshot } from "@/lib/types"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

const WIDGET_COORD_PREF = "codeg-whale-coord-v1"
const AVATAR_SIZE = 44
const SAFE_MARGIN_X = 12
const SAFE_TOP = 60
const SAFE_BOTTOM = 44
const DRAG_THRESHOLD_PX = 5

interface WidgetPosition {
  x: number
  y: number
}

function clampPosition(pos: WidgetPosition): WidgetPosition {
  if (typeof window === "undefined") return pos
  // 气泡向左或向右展开，最大边界需要减去 AVATAR_SIZE 和 margins
  const maxX = Math.max(
    SAFE_MARGIN_X,
    window.innerWidth - AVATAR_SIZE - SAFE_MARGIN_X
  )
  const maxY = Math.max(
    SAFE_TOP,
    window.innerHeight - AVATAR_SIZE - SAFE_BOTTOM
  )
  return {
    x: Math.min(Math.max(SAFE_MARGIN_X, pos.x), maxX),
    y: Math.min(Math.max(SAFE_TOP, pos.y), maxY),
  }
}

function defaultPosition(): WidgetPosition {
  if (typeof window === "undefined") {
    return { x: 16, y: SAFE_TOP + 6 }
  }

  // 默认位置：屏幕右上角边缘
  return clampPosition({
    x: window.innerWidth - AVATAR_SIZE - SAFE_MARGIN_X,
    y: SAFE_TOP,
  })
}

function loadSavedPosition(): WidgetPosition | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(WIDGET_COORD_PREF)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WidgetPosition>
    if (
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return clampPosition({ x: parsed.x, y: parsed.y })
    }
  } catch {
  }
  return null
}

function savePosition(pos: WidgetPosition): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(WIDGET_COORD_PREF, JSON.stringify(pos))
  } catch {
  }
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

export function WhaleBalanceWidget() {
  const t = useTranslations("WhaleBalanceWidget")
  const isMobile = useIsMobile()
  const hydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )

  const [snapshot, setSnapshot] = useState<WhaleBalanceSnapshot | null>(null)
  const [refreshingLocal, setRefreshingLocal] = useState(false)

  const [expandedByMode, setExpandedByMode] = useState({
    desktop: true,
    mobile: false,
  })
  const [position, setPosition] = useState<WidgetPosition>(
    () => loadSavedPosition() ?? defaultPosition()
  )
  const [dragging, setDragging] = useState(false)

  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)

  const suppressNextClickRef = useRef(false)

  const expanded = isMobile ? expandedByMode.mobile : expandedByMode.desktop

  const toggleExpanded = useCallback(() => {
    setExpandedByMode((prev) =>
      isMobile
        ? { ...prev, mobile: !prev.mobile }
        : { ...prev, desktop: !prev.desktop }
    )
  }, [isMobile])

  useEffect(() => {
    const handleResize = () => {
      setPosition((prev) => clampPosition(prev))
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  useEffect(() => {
    let cancelled = false
    let unsubEvent: (() => void) | undefined
    let unsubReconnect: (() => void) | undefined

    const loadState = () => {
      getWhaleBalanceState()
        .then((next) => {
          if (!cancelled) setSnapshot(next)
        })
        .catch(() => {
        })
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
      .catch(() => {
      })

    const transport = getTransport()
    if (transport.onReconnect) {
      unsubReconnect = transport.onReconnect(loadState)
    }

    return () => {
      cancelled = true
      unsubEvent?.()
      unsubReconnect?.()
    }
  }, [])

  const handleAvatarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") return
      const pointerId = event.pointerId ?? 0
      suppressNextClickRef.current = false
      dragStateRef.current = {
        pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
        moved: false,
      }
      event.currentTarget.setPointerCapture?.(pointerId)
    },
    [position.x, position.y]
  )

  const handleAvatarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const state = dragStateRef.current
      const pointerId = event.pointerId ?? 0
      if (!state || state.pointerId !== pointerId) return
      const dx = event.clientX - state.startX
      const dy = event.clientY - state.startY
      if (!state.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        state.moved = true
        setDragging(true)
      }
      if (state.moved) {
        setPosition(
          clampPosition({
            x: state.originX + dx,
            y: state.originY + dy,
          })
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
      dragStateRef.current = null
      setDragging(false)
      event.currentTarget.releasePointerCapture?.(pointerId)
      if (state.moved) {
        const finalPos = clampPosition({
          x: state.originX + (event.clientX - state.startX),
          y: state.originY + (event.clientY - state.startY),
        })
        setPosition(finalPos)
        savePosition(finalPos)
        suppressNextClickRef.current = true
        window.setTimeout(() => {
          suppressNextClickRef.current = false
        }, 0)
      }
    },
    []
  )

  const handleAvatarPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const state = dragStateRef.current
      const pointerId = event.pointerId ?? 0
      if (!state || state.pointerId !== pointerId) return
      dragStateRef.current = null
      setDragging(false)
    },
    []
  )

  const handleAvatarClick = useCallback(() => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }
    toggleExpanded()
  }, [toggleExpanded])

  const handleRefresh = useCallback(async () => {
    setRefreshingLocal(true)
    try {
      const next = await refreshWhaleBalance()
      setSnapshot(next)
    } catch {
    } finally {
      setRefreshingLocal(false)
    }
  }, [])

  const handleOpenSettings = useCallback(() => {
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

  const hasBalance = snapshot.balance !== null
  const balanceText = hasBalance ? formatAmount(snapshot.balance!) : "—"
  const summaryLine =
    hasBalance && snapshot.used !== null
      ? t("summaryWithUsed", {
          balance: balanceText,
          used: formatAmount(snapshot.used),
        })
      : balanceText

  const isSpinning = refreshingLocal || snapshot.refreshing
  const hasFailure = Boolean(snapshot.lastError) || snapshot.stale

  // 气泡展开方向判定：Avatar 中心在屏幕右半侧，气泡向左展开，Avatar 在右；反之亦然。
  const alignRight = position.x + AVATAR_SIZE / 2 >= (typeof window !== "undefined" ? window.innerWidth / 2 : 500)

  return (
    <div
      data-testid="whale-balance-widget"
      className={cn(
        "fixed z-40 flex items-center gap-2 select-none",
        alignRight ? "flex-row-reverse" : "flex-row"
      )}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
    >
      <button
        type="button"
        aria-label={t("toggleAriaLabel")}
        aria-expanded={expanded}
        onClick={handleAvatarClick}
        onPointerDown={handleAvatarPointerDown}
        onPointerMove={handleAvatarPointerMove}
        onPointerUp={handleAvatarPointerUp}
        onPointerCancel={handleAvatarPointerCancel}
        className={cn(
          "relative flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-full border border-border/80 bg-background/95 p-0.5 shadow-md backdrop-blur-sm transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          dragging ? "cursor-grabbing scale-105" : "cursor-grab"
        )}
      >
        <img
          src="/images/whale-widget.png"
          alt={t("avatarAlt")}
          draggable={false}
          className="h-full w-full rounded-full object-cover"
        />
        {hasFailure && !expanded && (
          <span
            aria-hidden="true"
            className="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full border border-background bg-amber-500"
          />
        )}
      </button>

      {expanded && (
        <div
          role="status"
          data-testid="whale-balance-bubble"
          title={snapshot.lastError ?? undefined}
          className={cn(
            "min-w-[164px] max-w-[240px] rounded-xl border border-border/80 bg-popover/95 px-3 py-2 text-popover-foreground shadow-md backdrop-blur-md",
            alignRight ? "mr-2" : "ml-2"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">{accountTitle}</span>
            <div className="flex shrink-0 items-center gap-0.5">
              {snapshot.configured && (
                <button
                  type="button"
                  aria-label={t("refreshAriaLabel")}
                  onClick={() => void handleRefresh()}
                  disabled={isSpinning}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw
                    className={cn("size-3", isSpinning && "animate-spin")}
                  />
                </button>
              )}
              <button
                type="button"
                aria-label={t("settingsAriaLabel")}
                onClick={handleOpenSettings}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Settings className="size-3" />
              </button>
            </div>
          </div>

          <div
            data-testid="whale-balance-summary"
            className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-foreground"
          >
            {summaryLine}
          </div>

          {!snapshot.configured ? (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {t("notConfiguredHint")}
            </div>
          ) : hasFailure && snapshot.lastSuccessAt ? (
            <div
              data-testid="whale-balance-stale"
              className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400"
            >
              {t("staleWithTime", {
                time: formatUpdatedTime(snapshot.lastSuccessAt),
              })}
            </div>
          ) : hasFailure ? (
            <div
              data-testid="whale-balance-error"
              className="mt-0.5 text-[11px] text-destructive"
            >
              {t("fetchFailed")}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
