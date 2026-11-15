"use client"

import {
  ArrowLeft,
  ArrowRight,
  Download,
  Folder,
  MousePointer2,
  Plus,
  RotateCw,
  Settings2,
  Upload,
  X,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { uploadAttachment } from "@/lib/api"
import { normalizeTypedAddress } from "./browser-toolbar"
import { publishEgoSession, registerEgoView } from "@/lib/browser/ego-workspace"
import {
  egoClientId,
  egoError,
  egoRequest,
  type EgoConfig,
  type EgoFrame,
  type EgoSession,
} from "@/lib/browser/ego-api"

const actionClass = "h-7 shrink-0 gap-1 px-2 text-xs"

export function EgoBrowserGateway({
  tab,
  children,
}: {
  tab: BrowserWorkspaceTab
  children: ReactNode
}) {
  const [config, setConfig] = useState<EgoConfig | null>(null)
  const [settings, setSettings] = useState(false)
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:9222")
  const [serverName, setServerName] = useState("")
  const [error, setError] = useState("")
  const [loaded, setLoaded] = useState(false)
  const configRevision = useRef(0)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      const revision = ++configRevision.current
      try {
        const result = await egoRequest<{ config: EgoConfig }>({
          method: "config",
        })
        if (disposed || revision !== configRevision.current) return
        setConfig(result.config)
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
  }, [])

  const save = async (enabled: boolean) => {
    try {
      const next = { enabled, endpoint, serverName }
      await egoRequest({ method: "configure", config: next })
      configRevision.current += 1
      setConfig(next)
      setSettings(false)
      setError("")
      window.dispatchEvent(new Event("codeg:ego-config-changed"))
    } catch (reason) {
      setError(egoError(reason))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <span className="min-w-0 flex-1 truncate">
          {config?.enabled ? "Ego · 执行端真实页面" : "内置浏览器"}
        </span>
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
              className="h-8"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0">Ego 实例名称</span>
            <Input
              className="h-8"
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
      {error && (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {!loaded ? (
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
              key={tab.browser.conversationId}
              viewId={tab.id}
              sessionId={tab.browser.conversationId}
              initialUrl={tab.browser.initialUrl}
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
}: {
  sessionId: number
  initialUrl: string
  viewId: string
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
  const [projectFiles, setProjectFiles] = useState<
    { name: string; path: string; directory: boolean }[]
  >([])
  const [promptText, setPromptText] = useState("")
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const latest = useRef<EgoSession | null>(null)
  const active = useRef<string | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const inputVersion = useRef(0)
  const upload = useRef<HTMLInputElement>(null)
  const keyboard = useRef<HTMLTextAreaElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const composing = useRef(false)
  const pointerState = useRef<{
    id: number
    x: number
    y: number
    touch: boolean
    moved: boolean
  } | null>(null)
  const lastMove = useRef(0)

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
    const version = inputVersion.current
    // 排队期间用户可能切页；输入始终交付产生该输入时的真实页面。
    const targetId = tabId === undefined ? active.current : tabId
    const operation = queue.current.then(async () => {
      if (
        !mounted.current ||
        version !== inputVersion.current ||
        !latest.current
      )
        return
      const next = await egoRequest<EgoSession>({
        method: "human",
        sessionId,
        viewId,
        clientId,
        epoch: latest.current.control.epoch,
        tabId: targetId,
        action,
      })
      accept(next)
      if (action.kind === "open") {
        active.current = next.tabs[next.tabs.length - 1]?.id ?? null
        setActiveId(active.current)
      }
      setError("")
    })
    queue.current = operation.catch((reason) => {
      inputVersion.current += 1
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
        const tabId = active.current
        if (
          tabId &&
          next.connected &&
          !next.control.recoveryRequired &&
          surface.current?.clientWidth
        ) {
          const image = await egoRequest<EgoFrame>({
            method: "frame",
            sessionId,
            tabId,
          })
          if (!stopped && tabId === active.current)
            setFrame({ ...image, tabId })
        }
      } catch (reason) {
        if (!stopped) {
          inputVersion.current += 1
          setError(egoError(reason))
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 400)
      }
    }
    const visit = egoRequest<EgoSession>({ method: "session", sessionId }).then(
      (state) =>
        egoRequest<EgoSession>({
          method: "visit",
          sessionId,
          viewId,
          url: initialUrl,
          clientId,
          epoch: state.control.epoch,
        })
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
      clearTimeout(timer)
    }
  }, [sessionId, viewId, initialUrl, clientId, accept])

  const tab = session?.tabs.find((entry) => entry.id === activeId)
  const tabUrl = tab?.url
  useEffect(() => {
    if (tabUrl) setAddress(tabUrl)
  }, [activeId, tabUrl])
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
  const choose = (id: string) => {
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
    try {
      await queue.current
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
    if (!editable || !frame || frame.tabId !== active.current) return
    const image = event.currentTarget.querySelector("img")
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
    const x = Math.max(
      0,
      Math.min(
        frame.width - 1,
        ((event.clientX - bounds.left) * frame.width) / bounds.width
      )
    )
    const y = Math.max(
      0,
      Math.min(
        frame.height - 1,
        ((event.clientY - bounds.top) * frame.height) / bounds.height
      )
    )
    if (type === "mousePressed") {
      event.preventDefault()
      pointerState.current = {
        id: event.pointerId,
        x,
        y,
        touch: event.pointerType === "touch",
        moved: false,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      keyboard.current?.focus({ preventScroll: true })
    }
    const state = pointerState.current
    if (type === "mouseMoved") {
      if (!state && session?.control.owner !== clientId) return
      if (Date.now() - lastMove.current < 35) return
      lastMove.current = Date.now()
      if (state?.touch) {
        const deltaX = state.x - x
        const deltaY = state.y - y
        if (Math.abs(deltaX) + Math.abs(deltaY) < 6 && !state.moved) return
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
      pointerState.current = null
      if (state?.moved) return
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
      button: ["left", "middle", "right"][event.button] ?? "none",
      buttons: event.buttons,
    })
  }
  const key = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    type: "keyDown" | "keyUp"
  ) => {
    if (
      !editable ||
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

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
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
      </div>
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
        className="flex min-h-8 shrink-0 items-center gap-1 overflow-x-auto border-b px-1"
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
              className={`truncate px-2 py-2 ${page.id === activeId ? "bg-muted text-foreground" : "text-muted-foreground"}`}
              onClick={() => choose(page.id)}
            >
              {page.live ? "" : "待恢复 · "}
              {page.title || page.url}
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
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
          className="size-7 shrink-0"
          aria-label="新建 Ego 页面"
          disabled={!editable}
          onClick={() => act({ kind: "open", url: "about:blank" })}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <form
        className="flex h-10 shrink-0 items-center gap-1 border-b px-2"
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
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
          className="size-7"
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
          className="size-7"
          aria-label="刷新"
          disabled={!editable || !tab}
          onClick={() => act({ kind: "reload" })}
        >
          <RotateCw className="size-3.5" />
        </Button>
        <Input
          aria-label="Ego 页面地址"
          className="h-7 min-w-0 flex-1 text-xs"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button className={actionClass} disabled={!editable}>
          前往
        </Button>
      </form>
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
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-muted/30"
        onPointerDown={(event) => pointer(event, "mousePressed")}
        onPointerUp={(event) => pointer(event, "mouseReleased")}
        onPointerMove={(event) => pointer(event, "mouseMoved")}
        onPointerCancel={(event) => {
          if (pointerState.current && !pointerState.current.touch)
            pointer(event, "mouseReleased")
          pointerState.current = null
        }}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={(event) => {
          if (!editable || !frame) return
          const image = event.currentTarget.querySelector("img")
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
            x: ((event.clientX - bounds.left) * frame.width) / bounds.width,
            y: ((event.clientY - bounds.top) * frame.height) / bounds.height,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
          })
        }}
      >
        {frame && frame.tabId === activeId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:image/jpeg;base64,${frame.data}`}
            alt="Ego 执行端真实页面"
            draggable={false}
            className="h-auto max-h-full w-auto max-w-full select-none object-contain"
            width={frame.width}
            height={frame.height}
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
        <textarea
          ref={keyboard}
          aria-label="向 Ego 页面输入"
          className="absolute bottom-0 left-0 size-px opacity-0"
          disabled={!editable}
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
}
