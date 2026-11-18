"use client"

import {
  ArrowLeft,
  ArrowRight,
  Download,
  Folder,
  Keyboard,
  Maximize,
  Minimize,
  MousePointer2,
  Pause,
  Play,
  Plus,
  RotateCw,
  Settings2,
  Upload,
  X,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { createPortal, flushSync } from "react-dom"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { uploadAttachment } from "@/lib/api"
import { useIsMobile } from "@/hooks/use-mobile"
import { useMobileViewport } from "@/hooks/use-mobile-viewport"
import { useEgoDisplaySize } from "@/hooks/use-ego-display-size"
import { normalizeTypedAddress } from "./browser-toolbar"
import { EgoContextMenu, type EgoContextMenuState } from "./ego-context-menu"
import {
  markEgoViewDisconnected,
  publishEgoSession,
  registerEgoView,
  setEgoWorkspaceSuspended,
  useEgoWorkspaceSuspended,
} from "@/lib/browser/ego-workspace"
import { EgoInputQueue } from "@/lib/browser/ego-input-queue"
import { egoPagePoint } from "@/lib/browser/ego-display"
import { watchEgoFrames } from "@/lib/browser/ego-frame-stream"
import { watchEgoPixels } from "@/lib/browser/ego-pixel-stream"
import { watchEgoRtc, type EgoRtcHandle } from "@/lib/browser/ego-rtc-stream"
import {
  egoVideoUnavailableReason,
  watchEgoVideo,
  type EgoVideoDiagnostics,
} from "@/lib/browser/ego-video-stream"
import {
  egoClientId,
  egoError,
  egoRequest,
  type EgoConfig,
  type EgoFrame,
  type EgoSession,
} from "@/lib/browser/ego-api"

const actionClass =
  "h-11 shrink-0 gap-1 px-2 text-xs sm:h-7 [@media(pointer:coarse)]:min-h-11"
const iconClass =
  "size-11 shrink-0 sm:size-7 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"

export function EgoBrowserGateway({
  tab,
  children,
}: {
  tab: BrowserWorkspaceTab
  children: ReactNode
}) {
  const suspended = useEgoWorkspaceSuspended(tab.id)
  const [config, setConfig] = useState<EgoConfig | null>(null)
  const [pixelDisplay, setPixelDisplay] = useState(false)
  const [settings, setSettings] = useState(false)
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:9222")
  const [serverName, setServerName] = useState("")
  const [error, setError] = useState("")
  const [loaded, setLoaded] = useState(false)
  const configRevision = useRef(0)
  useEffect(() => {
    if (suspended) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      const revision = ++configRevision.current
      try {
        const result = await egoRequest<{
          config: EgoConfig
          pixelDisplay?: boolean
        }>({
          method: "config",
        })
        if (disposed || revision !== configRevision.current) return
        setConfig(result.config)
        setPixelDisplay(result.pixelDisplay === true)
        setEndpoint((value) => value || result.config.endpoint)
        setServerName((value) => value || result.config.serverName)
      } catch (reason) {
        if (!disposed) setError(egoError(reason))
      } finally {
        if (!disposed) setLoaded(true)
      }
    }
    const poll = async () => {
      await refresh()
      if (!disposed) timer = setTimeout(() => void poll(), 2000)
    }
    const changed = () => void refresh()
    void poll()
    // 配置属于执行端；其他面板立即同步，其他设备由轮询续接，避免路由与画面不一致。
    window.addEventListener("codeg:ego-config-changed", changed)
    return () => {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener("codeg:ego-config-changed", changed)
    }
  }, [suspended])

  const save = async (enabled: boolean) => {
    try {
      const next = { enabled, endpoint, serverName }
      await egoRequest({ method: "configure", config: next })
      configRevision.current += 1
      setConfig(next)
      setSettings(false)
      setError("")
      setEgoWorkspaceSuspended(tab.id, false)
      window.dispatchEvent(new Event("codeg:ego-config-changed"))
    } catch (reason) {
      setError(egoError(reason))
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b px-2 text-xs sm:min-h-8">
        <span className="min-w-0 flex-1 truncate">
          {config?.enabled || suspended ? "Ego · 执行端真实页面" : "内置浏览器"}
        </span>
        {(config?.enabled || suspended) && (
          <Button
            variant="ghost"
            className={actionClass}
            aria-label={suspended ? "继续使用 Ego" : "挂起 Ego"}
            onClick={() => setEgoWorkspaceSuspended(tab.id, !suspended)}
          >
            {suspended ? (
              <Play className="size-3.5" />
            ) : (
              <Pause className="size-3.5" />
            )}
            {suspended ? "继续使用" : "挂起"}
          </Button>
        )}
        <Button
          variant="ghost"
          className={actionClass}
          onClick={() => {
            if (!settings && config) {
              setEndpoint(config.endpoint || "http://127.0.0.1:9222")
              setServerName(config.serverName)
            }
            setSettings(!settings)
          }}
        >
          <Settings2 className="size-3.5" />
          {settings ? "收起设置" : "连接 Ego"}
        </Button>
      </div>
      {settings && (
        <div className="space-y-2 border-b p-3 text-xs">
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0">执行端页面通道</span>
            <Input
              className="h-11 min-w-0 text-base sm:h-8 sm:text-xs"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0">Ego 实例名称</span>
            <Input
              className="h-11 min-w-0 text-base sm:h-8 sm:text-xs"
              value={serverName}
              onChange={(event) => setServerName(event.target.value)}
              placeholder="默认实例可留空"
            />
          </label>
          <p className="text-muted-foreground">
            连接执行端已启动的原版 Ego。首次需要以本机页面通道参数启动
            Ego，配置不会重启浏览器。
          </p>
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">首次连接步骤</summary>
            <p className="py-2">
              在执行机保存工作并自行退出 Ego，再用 PowerShell 启动原来的
              Ego。使用同一 Windows 账号与原有资料目录，保留网站登录态。
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 select-text">
              {
                '& "C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222'
              }
            </pre>
            <p className="py-2">
              安装位置不同时替换程序路径。页面通道填写
              http://127.0.0.1:9222，默认实例名称留空。此地址属于执行机；远程设备通过
              Codeg 访问，无需把 Ego 端口开放到网络。若无法连接，请检查 Ego
              是否真正退出后重新启动，以及端口是否被占用。
            </p>
          </details>
          <div className="flex gap-2">
            <Button className={actionClass} onClick={() => void save(true)}>
              连接 Ego
            </Button>
            {config?.enabled && (
              <Button
                variant="ghost"
                className={actionClass}
                onClick={() => void save(false)}
              >
                使用内置浏览器
              </Button>
            )}
          </div>
        </div>
      )}
      {error && !suspended && (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {suspended ? (
          <div className="space-y-1 p-3 text-xs text-muted-foreground">
            <p>Ego 已挂起</p>
            <p>画面连接已暂停，真实网页和 Agent 任务保留。</p>
          </div>
        ) : !loaded ? (
          <p className="p-3 text-xs text-muted-foreground">
            正在读取浏览器配置…
          </p>
        ) : !config ? (
          <p className="p-3 text-xs text-muted-foreground">
            浏览器配置暂不可读，请检查连接后重新打开面板。
          </p>
        ) : config.enabled ? (
          tab.browser.conversationId ? (
            <EgoBrowserView
              key={`${tab.browser.conversationId}:${pixelDisplay}`}
              viewId={tab.id}
              sessionId={tab.browser.conversationId}
              initialUrl={tab.browser.initialUrl}
              pixelDisplay={pixelDisplay}
            />
          ) : (
            <p className="p-3 text-xs text-muted-foreground">
              此浏览器页未绑定会话。请选择一个已保存的会话，再打开浏览器。
            </p>
          )
        ) : (
          children
        )}
      </div>
    </div>
  )
}

export function EgoBrowserView({
  sessionId,
  initialUrl,
  viewId,
  pixelDisplay = false,
}: {
  sessionId: number
  initialUrl: string
  viewId: string
  pixelDisplay?: boolean
}) {
  const [clientId] = useState(egoClientId)
  const [session, setSession] = useState<EgoSession | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [address, setAddress] = useState(initialUrl)
  const [frame, setFrame] = useState<(EgoFrame & { tabId: string }) | null>(
    null
  )
  const [error, setError] = useState("")
  const [projectDirectory, setProjectDirectory] = useState<string | null>(null)
  const [copyNotice, setCopyNotice] = useState("")
  const [copyFallback, setCopyFallback] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const placeholder = useRef<HTMLDivElement>(null)
  const [displayHost, setDisplayHost] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const host = document.createElement("div")
    host.className = "h-full min-h-0 w-full"
    setDisplayHost(host)
    return () => host.remove()
  }, [])
  useLayoutEffect(() => {
    if (!displayHost) return
    // 移动同一个 Portal 宿主越过 Pane 裁剪，保留视频节点、解码器及输入连接。
    const parent = fullscreen ? document.body : placeholder.current
    parent?.appendChild(displayHost)
  }, [displayHost, fullscreen])
  const isMobile = useIsMobile()
  const mobileViewport = useMobileViewport(fullscreen && isMobile)
  const displaySize = useEgoDisplaySize(isMobile)
  const rotated = fullscreen && isMobile && displaySize.portrait
  const orientationLocked = useRef(false)
  const fullscreenCurrent = useRef(fullscreen)
  fullscreenCurrent.current = fullscreen
  const [appliedViewport, setAppliedViewport] = useState("")
  const [viewportVersion, setViewportVersion] = useState(0)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [displayZoom, setDisplayZoom] = useState(1)
  const [projectFiles, setProjectFiles] = useState<
    { name: string; path: string; directory: boolean }[]
  >([])
  const [promptText, setPromptText] = useState("")
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<EgoContextMenuState | null>(
    null
  )
  const contextPosition = useRef<{
    tabId: string
    x: number
    y: number
  } | null>(null)
  const rightPointer = useRef<number | null>(null)
  const latest = useRef<EgoSession | null>(null)
  const active = useRef<string | null>(null)
  const queue = useRef(new EgoInputQueue())
  const inputVersion = useRef(0)
  const upload = useRef<HTMLInputElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const keyboard = useRef<HTMLTextAreaElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const pixels = useRef<HTMLCanvasElement>(null)
  const [pixelMode, setPixelMode] = useState(pixelDisplay)
  const [pixelTab, setPixelTab] = useState<string | null>(null)
  const [videoMode, setVideoMode] = useState(false)
  const [rtcMode, setRtcMode] = useState(false)
  const [displaySettings, setDisplaySettings] = useState(false)
  const rtc = useRef<EgoRtcHandle | null>(null)
  const [videoTab, setVideoTab] = useState<string | null>(null)
  const [videoNotice, setVideoNotice] = useState("")
  const [videoDiagnostics, setVideoDiagnostics] =
    useState<EgoVideoDiagnostics | null>(null)
  useEffect(() => {
    if (!pixelDisplay && typeof RTCPeerConnection !== "undefined")
      setRtcMode(true)
  }, [pixelDisplay])
  const mounted = useRef(true)
  const composing = useRef(false)
  const pointerState = useRef<{
    id: number
    x: number
    y: number
    touch: boolean
    moved: boolean
    held: boolean
    tabId: string
    clientX: number
    clientY: number
  } | null>(null)
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelLongPress = useCallback(() => {
    if (longPress.current !== null) clearTimeout(longPress.current)
    longPress.current = null
  }, [])
  const lastMove = useRef(0)
  const fullscreenEscape = useRef(false)
  const closeContextMenu = useCallback(() => {
    contextPosition.current = null
    setContextMenu(null)
    setCopyFallback(null)
  }, [])

  useEffect(
    () => () => {
      fullscreenCurrent.current = false
      if (orientationLocked.current) window.screen.orientation?.unlock?.()
    },
    []
  )
  useEffect(() => {
    if (!fullscreen && orientationLocked.current) {
      window.screen.orientation?.unlock?.()
      orientationLocked.current = false
    }
    const changed = () => {
      if (!document.fullscreenElement) setFullscreen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && fullscreen && !contextPosition.current) {
        // Esc 只退出本设备的显示模式，不透传为执行端按键或改变人工归属。
        event.preventDefault()
        event.stopImmediatePropagation()
        fullscreenEscape.current = true
        setFullscreen(false)
        if (document.fullscreenElement === container.current)
          void document.exitFullscreen?.().catch(() => {})
      }
    }
    const releaseEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && fullscreenEscape.current) {
        fullscreenEscape.current = false
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    document.addEventListener("fullscreenchange", changed)
    document.addEventListener("keydown", escape, true)
    document.addEventListener("keyup", releaseEscape, true)
    return () => {
      document.removeEventListener("fullscreenchange", changed)
      document.removeEventListener("keydown", escape, true)
      document.removeEventListener("keyup", releaseEscape, true)
    }
  }, [fullscreen])

  const toggleFullscreen = async () => {
    if (fullscreen) {
      setFullscreen(false)
      if (document.fullscreenElement === container.current)
        await document.exitFullscreen?.().catch(() => {})
    } else {
      flushSync(() => setFullscreen(true))
      // 仅响应用户点击；不支持原生全屏的移动端仍可在当前网页内铺满。
      await container.current?.requestFullscreen?.().catch(() => {})
      const orientation = window.screen.orientation as ScreenOrientation & {
        lock?: (value: string) => Promise<void>
      }
      if (isMobile && orientation?.lock && document.fullscreenElement) {
        try {
          await orientation.lock("landscape")
          if (fullscreenCurrent.current) orientationLocked.current = true
          else orientation.unlock?.()
        } catch {
          // 系统拒绝横屏时由显示层横向铺满，不激活执行端窗口。
        }
      }
    }
  }

  const accept = useCallback(
    (next: EgoSession) => {
      if (
        !mounted.current ||
        (latest.current &&
          (next.control.epoch < latest.current.control.epoch ||
            (next.control.epoch === latest.current.control.epoch &&
              next.revision < latest.current.revision)))
      )
        return
      if (
        latest.current?.control.owner === clientId &&
        next.control.owner !== clientId
      )
        inputVersion.current += 1
      latest.current = next
      setSession(next)
      publishEgoSession(next)
      const bound = next.views?.[viewId]
      if (
        active.current === null &&
        bound &&
        next.tabs.some((page) => page.id === bound)
      ) {
        active.current = bound
        setActiveId(bound)
      }
      if (!next.tabs.some((tab) => tab.id === active.current)) {
        active.current =
          next.tabs.find((tab) => tab.live)?.id ?? next.tabs[0]?.id ?? null
        setActiveId(active.current)
      }
    },
    [clientId, viewId]
  )

  const send = (action: Record<string, unknown>, tabId?: string | null) => {
    if (["open", "navigate"].includes(String(action.kind)) && manageViewport)
      action = {
        ...action,
        viewport: {
          mode: viewportMode,
          width: viewportWidth,
          height: viewportHeight,
        },
      }
    const version = inputVersion.current
    const menuPosition = contextPosition.current
    // 排队期间用户可能切页；输入始终交付产生该输入时的真实页面。
    const targetId = tabId === undefined ? active.current : tabId
    const operation = queue.current.push(
      `${version}:${targetId}`,
      action,
      async (latestAction) => {
        if (
          !mounted.current ||
          version !== inputVersion.current ||
          !latest.current
        )
          return
        if (
          latestAction.kind === "selectWord" &&
          (active.current !== targetId ||
            contextPosition.current !== menuPosition)
        )
          return
        const realtime =
          active.current === targetId &&
          ["pointer", "text", "key", "context", "selectWord"].includes(
            String(latestAction.kind)
          )
            ? rtc.current?.send(latest.current.control.epoch, latestAction)
            : null
        // 数据通道已接受的输入不能再走 HTTP 重发，避免点击或提交重复执行。
        const next = await (realtime ??
          egoRequest<EgoSession>({
            method: "human",
            sessionId,
            viewId,
            clientId,
            epoch: latest.current.control.epoch,
            tabId: targetId,
            action: latestAction,
          }))
        accept(next)
        if (
          ["context", "selectWord"].includes(String(latestAction.kind)) &&
          mounted.current &&
          version === inputVersion.current &&
          active.current === targetId &&
          next.control.owner === clientId &&
          latest.current?.control.epoch === next.control.epoch &&
          contextPosition.current === menuPosition &&
          menuPosition?.tabId === targetId
        ) {
          const details = next.contextMenu
          if (!details)
            throw new Error("当前服务尚不支持 Web 右键菜单，请更新验收服务。")
          if (
            details.handled ||
            (latestAction.kind === "selectWord" &&
              !details.selection &&
              !details.linkUrl)
          )
            closeContextMenu()
          else setContextMenu({ ...menuPosition, ...details })
        }
        if (action.kind === "open") {
          active.current = next.tabs[next.tabs.length - 1]?.id ?? null
          setActiveId(active.current)
        }
        setError("")
      }
    )
    void operation.catch((reason) => {
      inputVersion.current += 1
      if (["context", "selectWord"].includes(String(action.kind)))
        closeContextMenu()
      if (mounted.current) setError(egoError(reason))
    })
    return operation
  }

  useEffect(() => {
    mounted.current = true
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await egoRequest<EgoSession>({
          method: "session",
          sessionId,
        })
        if (stopped) return
        accept(next)
      } catch (reason) {
        if (!stopped) {
          markEgoViewDisconnected(viewId)
          inputVersion.current += 1
          setError(egoError(reason))
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 700)
      }
    }
    const visit = egoRequest<EgoSession>({ method: "session", sessionId }).then(
      (state) => {
        // 连接返回时查看可能已关闭或挂起，不能再为已离开的入口创建真实页面。
        if (stopped) return state
        const mobile = window.matchMedia(
          "(max-width: 767px), (max-width: 1023px) and (pointer: coarse)"
        ).matches
        const width = Math.max(
          320,
          Math.min(
            480,
            window.screen.width || window.innerWidth,
            window.screen.height || window.innerWidth,
            window.innerWidth
          )
        )
        return egoRequest<EgoSession>({
          method: "visit",
          sessionId,
          viewId,
          url: initialUrl,
          clientId,
          epoch: state.control.epoch,
          ...(mobile
            ? {
                viewport: {
                  mode: "mobile",
                  width,
                  height: Math.round(width * 1.4),
                },
              }
            : {}),
        })
      }
    )
    registerEgoView(viewId, sessionId, visit)
    void visit
      .then((next) => {
        if (!stopped) accept(next)
      })
      .catch((reason) => {
        if (!stopped) setError(egoError(reason))
      })
      .finally(() => {
        if (!stopped) void poll()
      })
    return () => {
      stopped = true
      mounted.current = false
      inputVersion.current += 1
      cancelLongPress()
      clearTimeout(timer)
    }
  }, [sessionId, viewId, initialUrl, clientId, accept, cancelLongPress])

  const tab = session?.tabs.find((entry) => entry.id === activeId)
  const tabUrl = tab?.url
  useEffect(() => {
    if (tabUrl) setAddress(tabUrl)
    closeContextMenu()
  }, [activeId, tabUrl, closeContextMenu])
  const dialogPrompt = frame?.dialog?.defaultPrompt
  const dialogMessage = frame?.dialog?.message
  useEffect(() => {
    setPromptText(dialogPrompt ?? "")
  }, [activeId, dialogPrompt, dialogMessage])
  const readOnly =
    session?.control.owner != null && session.control.owner !== clientId
  const paused = session?.control.owner != null
  const ready = session?.connected && !session.control.recoveryRequired
  const editable = ready && !readOnly
  const viewportMode = isMobile && !fullscreen ? "mobile" : "desktop"
  const viewportWidth =
    viewportMode === "mobile"
      ? Math.max(320, Math.min(480, displaySize.deviceWidth))
      : 1280
  const viewportHeight =
    viewportMode === "mobile"
      ? Math.round(viewportWidth * 1.4)
      : isMobile && fullscreen
        ? Math.max(
            240,
            Math.min(
              900,
              Math.round(
                (1280 * Math.max(160, displaySize.deviceWidth - 180)) /
                  displaySize.deviceHeight
              )
            )
          )
        : 720
  const manageViewport = isMobile || Boolean(tab?.viewport)
  const viewportKey = `${activeId}:${session?.control.epoch}:${viewportMode}:${viewportWidth}:${viewportHeight}`
  const viewportPending =
    ready &&
    session?.control.owner === clientId &&
    manageViewport &&
    appliedViewport !== viewportKey
  useEffect(() => {
    if (!viewportPending || !activeId) return
    let disposed = false
    const targetId = activeId
    const timer = setTimeout(() => {
      // 与实际输入共用队列；旧设备或已切走的页面不能迟到覆盖新视口。
      void queue.current
        .push(targetId, { kind: "viewport" }, async () => {
          const current = latest.current
          if (
            disposed ||
            !current ||
            current.control.owner !== clientId ||
            active.current !== targetId
          )
            return
          const next = await egoRequest<EgoSession>({
            method: "human",
            sessionId,
            clientId,
            epoch: current.control.epoch,
            tabId: targetId,
            action: {
              kind: "viewport",
              mode: viewportMode,
              width: viewportWidth,
              height: viewportHeight,
            },
          })
          if (disposed) return
          accept(next)
          // 同步更新已确认的输入坐标范围，避免清空元数据后吞掉切屏后的第一下。
          setFrame((previous) =>
            rtc.current
              ? {
                  data: "",
                  width: viewportWidth,
                  height: viewportHeight,
                  chooser:
                    previous?.tabId === targetId ? previous.chooser : null,
                  dialog: previous?.tabId === targetId ? previous.dialog : null,
                  tabId: targetId,
                }
              : null
          )
          // WebRTC 可在同一轨道内更新分辨率；重连反而重复协商并等待关键帧。
          if (!rtc.current) setVideoTab(null)
          setPixelTab(null)
          setAppliedViewport(viewportKey)
          setViewportVersion((value) => value + 1)
        })
        .catch((reason) => {
          if (!disposed) setError(egoError(reason))
        })
    }, 100)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [
    viewportPending,
    activeId,
    clientId,
    sessionId,
    viewportMode,
    viewportWidth,
    viewportHeight,
    viewportKey,
    accept,
  ])
  useEffect(() => {
    setKeyboardOpen(false)
    setDisplayZoom(1)
    if (isMobile && document.activeElement === keyboard.current)
      keyboard.current?.blur()
  }, [activeId, editable, isMobile])
  useEffect(() => {
    cancelLongPress()
    pointerState.current = null
  }, [activeId, tabUrl, editable, viewportPending, fullscreen, cancelLongPress])
  useEffect(() => {
    const cancel = () => {
      cancelLongPress()
      pointerState.current = null
      closeContextMenu()
    }
    const hidden = () => {
      if (document.visibilityState === "hidden") cancel()
    }
    window.addEventListener("blur", cancel)
    document.addEventListener("visibilitychange", hidden)
    return () => {
      window.removeEventListener("blur", cancel)
      document.removeEventListener("visibilitychange", hidden)
    }
  }, [cancelLongPress, closeContextMenu])
  const videoPlaying = (videoMode || rtcMode) && videoTab === activeId
  const pixelPlaying = pixelMode && pixelTab === activeId
  useEffect(() => {
    if (!pixelMode || !activeId || !ready || !pixels.current) return
    let stopped = false
    const cancel = watchEgoPixels(
      pixels.current,
      sessionId,
      activeId,
      clientId,
      (image) => {
        if (!stopped && active.current === activeId)
          setFrame((previous) => ({
            ...image,
            data: previous?.tabId === activeId ? previous.data : "",
            tabId: activeId,
          }))
      },
      () => {
        if (!stopped) setPixelTab(activeId)
      },
      (reason) => {
        if (!stopped) {
          setPixelMode(false)
          setPixelTab(null)
          setRtcMode(true)
          setVideoNotice(`${reason}，已自动恢复兼容显示。`)
        }
      },
      (details) => {
        if (!stopped) setVideoDiagnostics(details)
      }
    )
    if (!cancel) {
      setPixelMode(false)
      setRtcMode(true)
    }
    return () => {
      stopped = true
      cancel?.()
    }
  }, [
    pixelMode,
    activeId,
    ready,
    sessionId,
    clientId,
    displayHost,
    viewportVersion,
  ])
  useEffect(() => {
    if (!rtcMode || !activeId || !ready || !video.current) return
    let stopped = false
    const handle = watchEgoRtc(
      video.current,
      sessionId,
      activeId,
      viewId,
      clientId,
      () => {
        if (!stopped) setVideoTab(activeId)
      },
      (next) => {
        if (!stopped) accept(next)
      },
      (image) => {
        if (!stopped && active.current === activeId)
          setFrame((previous) => ({
            ...image,
            data: previous?.tabId === activeId ? previous.data : "",
            chooser: previous?.tabId === activeId ? previous.chooser : null,
            dialog: previous?.tabId === activeId ? previous.dialog : null,
            tabId: activeId,
          }))
      },
      (reason) => {
        if (!stopped) {
          rtc.current = null
          setRtcMode(false)
          setVideoTab(null)
          setVideoNotice(`${reason || "WebRTC 暂不可用"}，已回退原画面通道。`)
        }
      },
      (details) => {
        if (!stopped) setVideoDiagnostics(details)
      }
    )
    rtc.current = handle
    if (!handle) {
      setRtcMode(false)
      setVideoNotice("当前环境不支持 WebRTC，已回退原画面通道。")
    }
    return () => {
      stopped = true
      handle?.cancel()
      if (rtc.current === handle) rtc.current = null
    }
  }, [
    rtcMode,
    activeId,
    ready,
    sessionId,
    viewId,
    clientId,
    accept,
    displayHost,
  ])
  useEffect(() => {
    if (!videoMode || !activeId || !ready || !video.current) return
    let stopped = false
    const cancel = watchEgoVideo(
      video.current,
      sessionId,
      activeId,
      () => {
        if (!stopped) setVideoTab(activeId)
      },
      (reason) => {
        if (!stopped) {
          setVideoMode(false)
          setVideoTab(null)
          setVideoNotice(`${reason || "视频暂不可用"}，已回退原画面通道。`)
        }
      },
      (details) => {
        if (!stopped) setVideoDiagnostics(details)
      }
    )
    if (!cancel) {
      setVideoMode(false)
      setVideoNotice(
        `${egoVideoUnavailableReason() || "当前设备不支持此视频通道"}，继续使用原画面。`
      )
    }
    return () => {
      stopped = true
      cancel?.()
    }
  }, [videoMode, activeId, ready, sessionId, displayHost, viewportVersion])
  useEffect(() => {
    if (contextMenu && (!editable || activeId !== contextMenu.tabId || !paused))
      closeContextMenu()
  }, [contextMenu, editable, activeId, paused, closeContextMenu])
  useEffect(() => {
    if (!activeId || !ready) return
    let stopped = false
    let streaming = false
    let lastStreamFrame = 0
    let timer: ReturnType<typeof setTimeout>
    const receive = (image: EgoFrame) => {
      if (!stopped && active.current === activeId)
        setFrame((previous) => ({
          ...image,
          data:
            image.data || (previous?.tabId === activeId ? previous.data : ""),
          tabId: activeId,
        }))
    }
    const cancelStream =
      videoMode || rtcMode || pixelMode
        ? null
        : watchEgoFrames(
            sessionId,
            activeId,
            (image) => {
              streaming = true
              lastStreamFrame = performance.now()
              receive(image)
            },
            () => {
              streaming = false
            }
          )
    const pollFrame = async () => {
      const started = performance.now()
      try {
        // 有推流时不再重复截图；无推流时按完成耗时排期，不额外叠加固定 400ms。
        if (
          (!streaming || performance.now() - lastStreamFrame > 1200) &&
          surface.current?.clientWidth &&
          document.visibilityState !== "hidden"
        ) {
          const previousStreamFrame = lastStreamFrame
          const image = await egoRequest<EgoFrame>({
            method: "frame",
            sessionId,
            tabId: activeId,
            metadata: videoMode || rtcMode || pixelMode,
          })
          if (lastStreamFrame === previousStreamFrame) receive(image)
        }
      } catch (reason) {
        if (!stopped) setError(egoError(reason))
      } finally {
        if (!stopped)
          timer = setTimeout(
            () => void pollFrame(),
            videoMode || rtcMode || pixelMode
              ? 800
              : streaming
                ? 500
                : Math.max(0, 80 - (performance.now() - started))
          )
      }
    }
    void pollFrame()
    return () => {
      stopped = true
      cancelStream?.()
      clearTimeout(timer)
    }
  }, [
    sessionId,
    activeId,
    ready,
    videoMode,
    rtcMode,
    pixelMode,
    viewportVersion,
  ])
  const choose = (id: string) => {
    cancelLongPress()
    pointerState.current = null
    contextPosition.current = null
    setContextMenu(null)
    active.current = id
    setActiveId(id)
    setFrame(null)
    setProjectDirectory(null)
    setSelectedFiles([])
    void egoRequest<EgoSession>({
      method: "view",
      sessionId,
      viewId,
      tabId: id,
    })
      .then(accept)
      .catch((reason) => setError(egoError(reason)))
  }
  const act = (action: Record<string, unknown>, id?: string) => {
    void send(action, id).catch(() => {})
  }
  const transition = async (method: "return" | "restore") => {
    cancelLongPress()
    pointerState.current = null
    closeContextMenu()
    try {
      await queue.current.idle()
      const next = await egoRequest<EgoSession>({
        method,
        sessionId,
        clientId,
        epoch: latest.current?.control.epoch,
      })
      accept(next)
      setError("")
    } catch (reason) {
      setError(egoError(reason))
    }
  }
  const openProject = async (directory: string) => {
    const tabId = active.current
    try {
      const result = await egoRequest<{ entries: typeof projectFiles }>({
        method: "files",
        sessionId,
        directory,
      })
      if (tabId === active.current) {
        setProjectFiles(result.entries)
        setProjectDirectory(directory)
      }
    } catch (reason) {
      setError(egoError(reason))
    }
  }
  const uploadFiles = async (files: FileList | null) => {
    if (!files) return
    const tabId = active.current
    try {
      const selected = await Promise.all(
        Array.from(files).map(async (file) => {
          const stored = await uploadAttachment(file, String(sessionId))
          return { source: "upload", path: stored.path }
        })
      )
      await send({ kind: "files", files: selected }, tabId)
    } catch (reason) {
      setError(egoError(reason))
    }
    if (upload.current) upload.current.value = ""
  }
  const pointer = (event: React.PointerEvent<HTMLDivElement>, type: string) => {
    // 右键由 contextmenu 统一发送一次，避免 pointer 与菜单事件重复触发网页逻辑。
    if (event.button === 2) {
      if (type === "mousePressed") rightPointer.current = event.pointerId
      else if (type === "mouseReleased") rightPointer.current = null
      return
    }
    if (rightPointer.current === event.pointerId) return
    if (pointerState.current && pointerState.current.id !== event.pointerId) {
      cancelLongPress()
      pointerState.current.moved = true
      return
    }
    if (type === "mousePressed") closeContextMenu()
    if (
      !editable ||
      viewportPending ||
      !frame ||
      frame.tabId !== active.current
    )
      return
    const image = event.currentTarget.querySelector('[data-ego-surface="true"]')
    if (!image) return
    const bounds = image.getBoundingClientRect()
    if (
      !pointerState.current &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    )
      return
    const { x, y } = egoPagePoint(
      bounds,
      frame,
      event.clientX,
      event.clientY,
      rotated
    )
    if (type === "mousePressed") {
      cancelLongPress()
      if (!(isMobile && displayZoom > 1 && event.pointerType === "touch"))
        event.preventDefault()
      pointerState.current = {
        id: event.pointerId,
        x,
        y,
        touch: event.pointerType === "touch",
        moved: false,
        held: false,
        tabId: active.current!,
        clientX: event.clientX,
        clientY: event.clientY,
      }
      if (!(isMobile && displayZoom > 1 && event.pointerType === "touch"))
        event.currentTarget.setPointerCapture(event.pointerId)
      if (event.pointerType !== "touch")
        keyboard.current?.focus({ preventScroll: true })
      else {
        const pressed = pointerState.current
        const version = inputVersion.current
        const clientX = event.clientX
        const clientY = event.clientY
        longPress.current = setTimeout(() => {
          longPress.current = null
          if (
            !mounted.current ||
            pointerState.current !== pressed ||
            pressed.moved ||
            active.current !== pressed.tabId ||
            version !== inputVersion.current
          )
            return
          pressed.held = true
          contextPosition.current = {
            tabId: pressed.tabId,
            x: Math.max(0, Math.min(clientX, window.innerWidth - 224)),
            y: Math.max(0, Math.min(clientY - 48, window.innerHeight - 320)),
          }
          // 不模拟整页双击，避免长按链接时发生导航；选区由真实 Ego 页面建立。
          act({ kind: "selectWord", x: pressed.x, y: pressed.y }, pressed.tabId)
        }, 500)
      }
    }
    const state = pointerState.current
    if (type === "mouseMoved") {
      if (
        state?.touch &&
        !state.held &&
        Math.hypot(
          event.clientX - state.clientX,
          event.clientY - state.clientY
        ) >= 6
      ) {
        // 先取消长按再节流；不能漏掉 35ms 内的快速滑动而误弹选词菜单。
        cancelLongPress()
        state.moved = true
      }
      if (!state && session?.control.owner !== clientId) return
      if (Date.now() - lastMove.current < 35) return
      lastMove.current = Date.now()
      if (state?.touch) {
        if (state.held) return
        // 放大后由本设备平移画面，不能把查看细节的手势误发成远端滚动。
        if (isMobile && displayZoom > 1) return
        const deltaX = state.x - x
        const deltaY = state.y - y
        if (!state.moved) return
        cancelLongPress()
        state.moved = true
        state.x = x
        state.y = y
        act({
          kind: "pointer",
          type: "mouseWheel",
          button: "none",
          x,
          y,
          deltaX,
          deltaY,
        })
        return
      }
    }
    if (event.pointerType === "touch") {
      if (type !== "mouseReleased") return
      cancelLongPress()
      pointerState.current = null
      if (!state || state.moved || state.held || state.tabId !== active.current)
        return
      // 手机点击按钮和链接不应每次弹出键盘；输入由明确的键盘按钮开启。
      if (!isMobile || keyboardOpen)
        keyboard.current?.focus({ preventScroll: true })
      act({
        kind: "pointer",
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
      })
    }
    if (type === "mouseReleased") pointerState.current = null
    act({
      kind: "pointer",
      type,
      x,
      y,
      // pointermove 的 button=-1 表示本次没有按键变化，不代表没有按住鼠标；拖选必须看 buttons。
      button:
        type === "mouseMoved"
          ? event.buttons & 1
            ? "left"
            : event.buttons & 2
              ? "right"
              : event.buttons & 4
                ? "middle"
                : "none"
          : (["left", "middle", "right"][event.button] ?? "none"),
      buttons: event.buttons,
    })
  }
  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    // 触屏长按已有明确选词动作，忽略平台随后合成的右键，避免清除选区。
    if (
      pointerState.current?.touch ||
      (event.nativeEvent as PointerEvent).pointerType === "touch"
    )
      return
    rightPointer.current = null
    if (
      !editable ||
      viewportPending ||
      !frame ||
      frame.tabId !== active.current ||
      !active.current
    )
      return
    const image = event.currentTarget.querySelector('[data-ego-surface="true"]')
    if (!image) return
    const bounds = image.getBoundingClientRect()
    if (
      !bounds.width ||
      !bounds.height ||
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      return
    contextPosition.current = {
      tabId: active.current,
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - 224)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - 320)),
    }
    setContextMenu(null)
    act({
      kind: "context",
      ...egoPagePoint(bounds, frame, event.clientX, event.clientY, rotated),
      modifiers:
        Number(event.altKey) +
        Number(event.ctrlKey) * 2 +
        Number(event.metaKey) * 4 +
        Number(event.shiftKey) * 8,
    })
  }
  const copyContextText = async (text: string) => {
    if (!editable || !contextMenu || contextMenu.tabId !== active.current)
      return
    setCopyNotice("")
    try {
      const legacyCopy = () => {
        // 局域网 HTTP 没有 Clipboard API，保留本设备复制入口，不读写执行机剪贴板。
        const field = document.createElement("textarea")
        field.value = text
        field.readOnly = true
        field.style.position = "fixed"
        field.style.opacity = "0"
        field.style.fontSize = "16px"
        container.current?.append(field)
        try {
          field.focus({ preventScroll: true })
          field.select()
          field.setSelectionRange(0, text.length)
          if (!document.execCommand("copy"))
            throw new Error("当前设备不允许复制，请使用 HTTPS 后重试。")
        } finally {
          field.remove()
        }
      }
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          legacyCopy()
        }
      } else legacyCopy()
      setCopyNotice("已复制到当前设备")
      setError("")
      closeContextMenu()
    } catch (reason) {
      setCopyFallback(text)
      setError(egoError(reason))
    }
  }
  const key = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    type: "keyDown" | "keyUp"
  ) => {
    if (
      !editable ||
      viewportPending ||
      composing.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return
    // 粘贴由本设备 clipboardData 交付；不再同时触发执行端系统剪贴板。
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v")
      return
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault()
      if (type === "keyDown") act({ kind: "text", text: event.key })
      return
    }
    event.preventDefault()
    act({
      kind: "key",
      type,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      modifiers:
        Number(event.altKey) +
        Number(event.ctrlKey) * 2 +
        Number(event.metaKey) * 4 +
        Number(event.shiftKey) * 8,
    })
  }
  const downloadFile = async (id: string, name: string) => {
    try {
      const parts: Uint8Array<ArrayBuffer>[] = []
      let offset = 0
      let size = 0
      do {
        const chunk = await egoRequest<{ data: string; size: number }>({
          method: "downloadData",
          sessionId,
          downloadId: id,
          offset,
        })
        const bytes = Uint8Array.from(atob(chunk.data), (character) =>
          character.charCodeAt(0)
        )
        size = chunk.size
        if (!bytes.length && offset < size)
          throw new Error("下载内容已变化，请重试。")
        parts.push(bytes)
        offset += bytes.length
      } while (offset < size)
      const url = URL.createObjectURL(
        new Blob(parts, { type: "application/octet-stream" })
      )
      const link = document.createElement("a")
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) {
      setError(egoError(reason))
    }
  }

  const content = (
    <div
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-background text-xs ${rotated ? "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-90" : "h-full w-full"}`}
      style={
        rotated
          ? { width: displaySize.height, height: displaySize.width }
          : undefined
      }
      data-ego-rotated={rotated || undefined}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-1 border-b px-2 sm:min-h-8">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          会话 {sessionId} ·{" "}
          {readOnly
            ? "只读观看"
            : paused
              ? "人工接管，Agent 已暂停"
              : "Agent 可操作"}
        </span>
        {readOnly && (
          <Button
            className={actionClass}
            disabled={!session?.connected}
            onClick={() => act({ kind: "takeover" })}
          >
            <MousePointer2 className="size-3.5" />
            接管到此设备
          </Button>
        )}
        {paused && !readOnly && (
          <Button
            className={actionClass}
            disabled={!ready}
            onClick={() => void transition("return")}
          >
            交还 Agent
          </Button>
        )}
        <span
          className="hidden shrink-0 text-muted-foreground sm:inline"
          aria-label="当前画面通道"
        >
          {rtcMode || videoMode || pixelMode
            ? videoPlaying || pixelPlaying
              ? "实时画面"
              : "正在连接…"
            : "兼容画面"}
        </span>
        <Button
          variant="ghost"
          className={actionClass}
          aria-expanded={displaySettings}
          aria-label="显示设置"
          onClick={() => setDisplaySettings(!displaySettings)}
        >
          <Settings2 className="size-3.5" />
          <span className="hidden sm:inline">显示</span>
        </Button>
        <Button
          variant="ghost"
          className={actionClass}
          aria-label={fullscreen ? "退出 Ego 全屏" : "全屏显示 Ego"}
          title={fullscreen ? "退出全屏（Esc）" : "全屏显示 Ego"}
          aria-pressed={fullscreen}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? (
            <Minimize className="size-3.5" />
          ) : (
            <Maximize className="size-3.5" />
          )}
          <span className="hidden sm:inline">
            {fullscreen ? "退出全屏" : "全屏"}
          </span>
        </Button>
      </div>
      {viewportPending && (
        <p
          role="status"
          className="shrink-0 border-b px-3 py-1 text-muted-foreground"
        >
          正在切换{viewportMode === "mobile" ? "移动" : "桌面"}页面…
        </p>
      )}
      {displaySettings && (
        <div
          role="region"
          aria-label="显示设置"
          className="shrink-0 space-y-2 border-b px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">画面模式</span>
            {[
              { label: "实时（推荐）", mode: "rtc" },
              { label: "兼容画面", mode: "image" },
            ].map(({ label, mode }) => (
              <Button
                key={mode}
                variant="ghost"
                className={actionClass}
                aria-pressed={
                  mode === "rtc"
                    ? rtcMode || pixelMode
                    : !rtcMode && !videoMode && !pixelMode
                }
                onClick={() => {
                  if (
                    mode === "rtc"
                      ? rtcMode || pixelMode
                      : !rtcMode && !videoMode && !pixelMode
                  )
                    return
                  // 切换只重连显示，不改变页面归属，也不替用户交还 Agent。
                  setVideoTab(null)
                  setVideoNotice("")
                  setVideoDiagnostics(null)
                  setVideoMode(false)
                  setPixelTab(null)
                  setPixelMode(mode === "rtc" && pixelDisplay)
                  setRtcMode(mode === "rtc" && !pixelDisplay)
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground">
            默认使用低延迟实时画面；连接失败会自动回退，无需选择技术通道。
          </p>
          {isMobile && (
            <div className="flex items-center gap-2" aria-label="画面缩放">
              <span className="shrink-0">画面大小</span>
              {[
                { value: 1, label: "适应" },
                { value: 1.5, label: "150%" },
                { value: 2, label: "200%" },
              ].map(({ value, label }) => (
                <Button
                  key={value}
                  variant="ghost"
                  className={actionClass}
                  aria-pressed={displayZoom === value}
                  onClick={() => {
                    cancelLongPress()
                    pointerState.current = null
                    setDisplayZoom(value)
                    if (surface.current) {
                      surface.current.scrollLeft = 0
                      surface.current.scrollTop = 0
                    }
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">高级排障</summary>
            <Button
              variant="ghost"
              className={actionClass}
              aria-pressed={videoMode}
              onClick={() => {
                if (videoMode) return
                setVideoTab(null)
                setVideoNotice("")
                setVideoDiagnostics(null)
                setRtcMode(false)
                setPixelMode(false)
                setPixelTab(null)
                setVideoMode(true)
              }}
            >
              兼容视频（仅排障）
            </Button>
          </details>
        </div>
      )}
      {videoNotice && (
        <p role="status" className="border-b px-3 py-1 text-muted-foreground">
          {videoNotice}
        </p>
      )}
      {session?.control.recoveryRequired && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="flex-1">
            执行环境已重新连接。确认恢复页面后再继续任务；人工接管状态会保留。
          </span>
          <Button
            className={actionClass}
            disabled={readOnly}
            onClick={() => void transition("restore")}
          >
            确认恢复
          </Button>
        </div>
      )}
      {(error || session?.blocked) && (
        <p role="alert" className="border-b px-3 py-2 text-destructive">
          {error || session?.blocked}
        </p>
      )}
      {session?.evalRequest && (
        <div
          className="space-y-2 border-b p-3"
          role="region"
          aria-label="Agent 页面代码确认"
        >
          <p>Agent 请求在页面中执行以下代码。</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
            {session.evalRequest.code}
          </pre>
          {[true, false].map((allow) => (
            <Button
              key={String(allow)}
              variant={allow ? "default" : "ghost"}
              className={actionClass}
              disabled={readOnly || !ready}
              onClick={() => {
                void egoRequest<EgoSession>({
                  method: "evalDecision",
                  sessionId,
                  clientId,
                  epoch: latest.current?.control.epoch,
                  id: session.evalRequest?.id,
                  allow,
                })
                  .then(accept)
                  .catch((reason) => setError(egoError(reason)))
              }}
            >
              {allow ? "允许本次代码" : "拒绝"}
            </Button>
          ))}
        </div>
      )}
      <div
        className="flex min-h-11 shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain border-b px-1 sm:min-h-8"
        role="tablist"
        aria-label="Ego 页面"
      >
        {session?.tabs.map((page) => (
          <div
            key={page.id}
            className="flex max-w-52 shrink-0 items-center border-r"
          >
            <button
              role="tab"
              aria-selected={page.id === activeId}
              className={`min-h-11 min-w-0 truncate px-2 py-2 sm:min-h-8 ${page.id === activeId ? "bg-muted text-foreground" : "text-muted-foreground"}`}
              onClick={() => choose(page.id)}
            >
              {page.live ? "" : "待恢复 · "}
              {page.title || page.url}
            </button>
            <Button
              variant="ghost"
              size="icon"
              className={iconClass}
              aria-label={`关闭 ${page.title || page.url}`}
              disabled={!editable}
              onClick={() => act({ kind: "close" }, page.id)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className={iconClass}
          aria-label="新建 Ego 页面"
          disabled={!editable}
          onClick={() => act({ kind: "open", url: "about:blank" })}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <form
        className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 border-b px-2 py-1 sm:flex"
        onSubmit={(event) => {
          event.preventDefault()
          const url =
            address.trim() === "about:blank"
              ? "about:blank"
              : normalizeTypedAddress(address)
          if (!url) {
            setError(
              "请输入有效的网址，例如 localhost:3000 或 https://example.com。"
            )
            return
          }
          act({ kind: tab ? "navigate" : "open", url })
        }}
      >
        <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-1 sm:contents">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={iconClass}
            aria-label="后退"
            disabled={!editable || !tab}
            onClick={() => act({ kind: "back" })}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={iconClass}
            aria-label="前进"
            disabled={!editable || !tab}
            onClick={() => act({ kind: "forward" })}
          >
            <ArrowRight className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={iconClass}
            aria-label="刷新"
            disabled={!editable || !tab}
            onClick={() => act({ kind: "reload" })}
          >
            <RotateCw className="size-3.5" />
          </Button>
          {isMobile && (
            <Button
              type="button"
              variant="ghost"
              className={`${actionClass} ml-auto`}
              aria-label={
                keyboardOpen ? "收起 Ego 输入键盘" : "打开 Ego 输入键盘"
              }
              aria-pressed={keyboardOpen}
              disabled={!editable || viewportPending || !tab}
              onClick={() => {
                if (keyboardOpen) {
                  keyboard.current?.blur()
                  setKeyboardOpen(false)
                } else {
                  flushSync(() => setKeyboardOpen(true))
                  keyboard.current?.focus({ preventScroll: true })
                }
              }}
            >
              <Keyboard className="size-4" />
              {keyboardOpen ? "收起键盘" : "输入"}
            </Button>
          )}
        </div>
        <Input
          aria-label="Ego 页面地址"
          className="col-start-1 row-start-1 h-11 min-w-0 flex-1 text-base sm:h-7 sm:text-xs [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:text-base"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button
          className={`${actionClass} col-start-2 row-start-1`}
          disabled={!editable}
        >
          前往
        </Button>
      </form>
      {isMobile && keyboardOpen && editable && (
        <div
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2"
          aria-label="Ego 输入辅助按键"
        >
          {[
            { label: "Tab", key: "Tab", code: "Tab", keyCode: 9 },
            { label: "回车", key: "Enter", code: "Enter", keyCode: 13 },
            { label: "退格", key: "Backspace", code: "Backspace", keyCode: 8 },
            { label: "Esc", key: "Escape", code: "Escape", keyCode: 27 },
          ].map(({ label, ...details }) => (
            <Button
              key={details.key}
              variant="ghost"
              className={actionClass}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                act({ kind: "key", type: "keyDown", ...details })
                act({ kind: "key", type: "keyUp", ...details })
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      {frame?.dialog && frame.tabId === activeId && (
        <div
          role="alertdialog"
          aria-label="网页提示"
          className="space-y-2 border-b p-3"
        >
          <p>{frame.dialog.message}</p>
          {frame.dialog.type === "prompt" && (
            <Input
              aria-label="网页提示输入"
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
            />
          )}
          <Button
            className={actionClass}
            disabled={!editable}
            onClick={() =>
              act({ kind: "dialog", accept: true, text: promptText })
            }
          >
            确认
          </Button>
          <Button
            variant="ghost"
            className={actionClass}
            disabled={!editable}
            onClick={() => act({ kind: "dialog", accept: false })}
          >
            取消
          </Button>
        </div>
      )}
      {frame?.chooser && frame.tabId === activeId && (
        <div className="flex shrink-0 items-center gap-2 border-b p-2">
          <span>网页正在选择文件</span>
          <Button
            variant="ghost"
            className={actionClass}
            disabled={!editable}
            onClick={() => upload.current?.click()}
          >
            <Upload className="size-3.5" />
            当前设备
          </Button>
          <Button
            variant="ghost"
            className={actionClass}
            disabled={!editable}
            onClick={() => void openProject("")}
          >
            <Folder className="size-3.5" />
            执行端项目
          </Button>
          <Button
            variant="ghost"
            className={actionClass}
            disabled={!editable}
            onClick={() => act({ kind: "files", files: [] })}
          >
            取消
          </Button>
        </div>
      )}
      <input
        ref={upload}
        type="file"
        className="hidden"
        multiple={frame?.chooser?.mode === "selectMultiple"}
        onChange={(event) => void uploadFiles(event.target.files)}
      />
      {projectDirectory !== null && (
        <div className="max-h-52 shrink-0 overflow-auto border-b p-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              项目文件 / {projectDirectory}
            </span>
            <Button
              variant="ghost"
              className={actionClass}
              onClick={() =>
                void openProject(
                  projectDirectory.split(/[\\/]/).slice(0, -1).join("/")
                )
              }
            >
              上级目录
            </Button>
            <Button
              variant="ghost"
              className={actionClass}
              onClick={() => setProjectDirectory(null)}
            >
              关闭
            </Button>
          </div>
          {projectFiles.map((file) => (
            <button
              key={file.path}
              className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-muted"
              aria-pressed={selectedFiles.includes(file.path)}
              onClick={() => {
                if (file.directory) void openProject(file.path)
                else if (frame?.chooser?.mode === "selectMultiple")
                  setSelectedFiles((previous) =>
                    previous.includes(file.path)
                      ? previous.filter((entry) => entry !== file.path)
                      : [...previous, file.path]
                  )
                else {
                  act({
                    kind: "files",
                    files: [{ source: "project", path: file.path }],
                  })
                  setProjectDirectory(null)
                }
              }}
            >
              {selectedFiles.includes(file.path) ? "✓ " : ""}
              {file.directory ? `${file.name}/` : file.name}
            </button>
          ))}
          {!!selectedFiles.length && (
            <Button
              className={actionClass}
              disabled={!editable}
              onClick={() => {
                act({
                  kind: "files",
                  files: selectedFiles.map((path) => ({
                    source: "project",
                    path,
                  })),
                })
                setSelectedFiles([])
                setProjectDirectory(null)
              }}
            >
              使用所选 {selectedFiles.length} 个文件
            </Button>
          )}
        </div>
      )}
      <div
        ref={surface}
        aria-label="Ego 页面画面区域"
        className={`relative flex min-h-0 min-w-0 flex-1 bg-muted/30 ${isMobile && displayZoom > 1 ? "touch-auto items-start justify-start overflow-auto overscroll-contain" : "touch-none items-center justify-center overflow-hidden"}`}
        onPointerDown={(event) => pointer(event, "mousePressed")}
        onPointerUp={(event) => pointer(event, "mouseReleased")}
        onPointerMove={(event) => pointer(event, "mouseMoved")}
        onPointerCancel={(event) => {
          cancelLongPress()
          closeContextMenu()
          if (pointerState.current && !pointerState.current.touch)
            pointer(event, "mouseReleased")
          pointerState.current = null
        }}
        onLostPointerCapture={() => {
          cancelLongPress()
          pointerState.current = null
        }}
        onContextMenu={openContextMenu}
        onWheel={(event) => {
          if (!editable || viewportPending || !frame) return
          const image = event.currentTarget.querySelector(
            '[data-ego-surface="true"]'
          )
          if (!image) return
          const bounds = image.getBoundingClientRect()
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            return
          act({
            kind: "pointer",
            type: "mouseWheel",
            button: "none",
            ...egoPagePoint(
              bounds,
              frame,
              event.clientX,
              event.clientY,
              rotated
            ),
            deltaX: rotated ? event.deltaY : event.deltaX,
            deltaY: rotated ? -event.deltaX : event.deltaY,
          })
        }}
      >
        <div
          className="relative flex h-full min-h-0 w-full shrink-0 items-center justify-center"
          style={
            isMobile && displayZoom > 1
              ? {
                  width: `${displayZoom * 100}%`,
                  height: `${displayZoom * 100}%`,
                }
              : undefined
          }
        >
          {frame && frame.tabId === activeId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              data-ego-surface={!videoPlaying && !pixelPlaying}
              src={`data:image/${frame.format === "png" ? "png" : "jpeg"};base64,${frame.data}`}
              alt="Ego 执行端真实页面"
              draggable={false}
              className="h-auto max-h-full w-auto max-w-full select-none object-contain"
              width={frame.width}
              height={frame.height}
              style={
                videoPlaying || pixelPlaying ? { display: "none" } : undefined
              }
            />
          ) : (
            <p className="px-4 text-center text-muted-foreground">
              {!session
                ? "正在连接 Ego…"
                : !tab
                  ? "输入地址打开页面。页面会保留到您主动关闭。"
                  : !ready || !tab.live
                    ? "页面暂不可用，请查看上方连接提示并确认恢复。"
                    : "正在获取真实页面…"}
            </p>
          )}
          {pixelMode && ready && activeId && (
            <canvas
              key={`pixels-${activeId}`}
              ref={pixels}
              data-ego-surface={pixelPlaying}
              aria-label="Ego 执行端真实页面画面"
              className="h-auto max-h-full w-auto max-w-full select-none object-contain"
              style={pixelPlaying ? undefined : { position: "absolute" }}
            />
          )}
          {(videoMode || rtcMode) && ready && activeId && (
            <video
              key={activeId}
              ref={video}
              data-ego-surface={videoPlaying}
              aria-label="Ego 执行端视频画面"
              autoPlay
              muted
              playsInline
              className="h-auto max-h-full w-auto max-w-full select-none object-contain"
              width={frame?.width}
              height={frame?.height}
              style={videoPlaying ? undefined : { position: "absolute" }}
            />
          )}
        </div>
        <textarea
          ref={keyboard}
          aria-label="向 Ego 页面输入"
          className="absolute bottom-0 left-0 size-px text-base opacity-0"
          inputMode={isMobile && !keyboardOpen ? "none" : "text"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={!editable || viewportPending}
          onKeyDown={(event) => key(event, "keyDown")}
          onKeyUp={(event) => key(event, "keyUp")}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={(event) => {
            composing.current = false
            act({ kind: "text", text: event.data })
            event.currentTarget.value = ""
          }}
          onPaste={(event) => {
            event.preventDefault()
            act({ kind: "text", text: event.clipboardData.getData("text") })
          }}
          onChange={(event) => {
            if (composing.current) return
            const text = event.currentTarget.value
            if (text) act({ kind: "text", text })
            event.currentTarget.value = ""
          }}
        />
      </div>
      {contextMenu && editable && contextMenu.tabId === activeId && (
        <EgoContextMenu
          menu={contextMenu}
          portal={
            fullscreen && container.current ? container.current : document.body
          }
          onClose={closeContextMenu}
          onAction={act}
          onCopy={(text) => void copyContextText(text)}
          copyFallback={copyFallback}
        />
      )}
      {copyNotice && (
        <p
          role="status"
          className="shrink-0 border-t px-3 py-1 text-muted-foreground"
        >
          {copyNotice}
        </p>
      )}
      {(videoMode || rtcMode || videoNotice) && (
        <details className="shrink-0 border-t px-3 py-1 text-muted-foreground">
          <summary className="cursor-pointer">连接诊断</summary>
          <p className="break-all py-1">
            当前访问：{typeof location !== "undefined" ? location.origin : ""} ·{" "}
            {rtcMode
              ? "WebRTC 媒体与输入通道"
              : egoVideoUnavailableReason() || "视频能力可用"}
          </p>
          {videoDiagnostics && (
            <p>
              {videoDiagnostics.stage} · 第 {videoDiagnostics.attempt} 次连接 ·{" "}
              {videoDiagnostics.width}×{videoDiagnostics.height} ·{" "}
              {videoDiagnostics.fps == null
                ? "帧率待确认"
                : `${videoDiagnostics.fps.toFixed(1)} fps`}{" "}
              · 缓冲 {Math.round(videoDiagnostics.bufferMs)}ms · 已收{" "}
              {Math.round(videoDiagnostics.bytes / 1024)}KB
              {videoDiagnostics.reason ? ` · ${videoDiagnostics.reason}` : ""}
              {videoDiagnostics.transport
                ? ` · ${videoDiagnostics.transport}`
                : ""}
              {videoDiagnostics.roundTripMs != null
                ? ` · RTT ${Math.round(videoDiagnostics.roundTripMs)}ms`
                : ""}
            </p>
          )}
        </details>
      )}
      {!!session?.downloads.length && (
        <div className="max-h-28 shrink-0 overflow-auto border-t px-2 py-1">
          {session.downloads.map((download) => (
            <div key={download.id} className="flex items-center gap-2 py-1">
              <span className="min-w-0 flex-1 truncate">{download.name}</span>
              <span className="text-muted-foreground">
                {download.state === "completed"
                  ? "已保存在执行端"
                  : download.state === "inProgress"
                    ? `${download.bytes} / ${download.total || "…"}`
                    : download.state === "interrupted"
                      ? "传输已中断，请在网站重新下载"
                      : download.state}
              </span>
              <Button
                variant="ghost"
                className={actionClass}
                disabled={download.state !== "completed"}
                onClick={() => void downloadFile(download.id, download.name)}
              >
                <Download className="size-3.5" />
                取回
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
  // 工作区 Pane 可能裁剪或变换子元素；网页内全屏必须越过该布局边界。
  return (
    <>
      <div ref={placeholder} className="h-full min-h-0 w-full" />
      {displayHost &&
        createPortal(
          <div
            ref={(element) => {
              container.current = element
              mobileViewport.current = element
            }}
            role="region"
            aria-label="Ego 浏览器"
            className={
              fullscreen
                ? "fixed inset-0 z-[100] h-dvh w-full overflow-hidden bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
                : "h-full min-h-0 w-full overflow-hidden bg-background"
            }
          >
            {content}
          </div>,
          displayHost
        )}
    </>
  )
}
