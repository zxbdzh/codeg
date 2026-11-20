"use client"

import { useEffect, useRef, useState, type PointerEvent } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Download,
  Loader2,
  RotateCw,
  Upload,
  X,
} from "lucide-react"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import { emulatedViewport } from "@/lib/browser/browser-device"
import { setBrowserTabState } from "@/lib/browser/browser-tab-store"
import { browserTabBackendId } from "@/lib/file-tab-id"
import {
  downloadBrowserFile,
  uploadBrowserFiles,
  webBrowserSocket,
  rememberWebBrowserTab,
} from "@/lib/browser/web-browser"

import { ICON_BTN } from "./browser-toolbar-buttons"

interface Props {
  tab: BrowserWorkspaceTab
  url: string
  reloadKey: number
  onNavigate: (url: string) => void
}

function modifiers(event: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}) {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  )
}

export function BrowserWebSurface({ tab, url, reloadKey, onNavigate }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const socket = useRef<WebSocket | null>(null)
  const currentUrl = useRef(url)
  const reload = useRef(reloadKey)
  const navigate = useRef(onNavigate)
  const hoverAt = useRef(0)
  const [retry, setRetry] = useState(0)
  const [connected, setConnected] = useState(false)
  const [painted, setPainted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState({ back: false, forward: false })
  const [popup, setPopup] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{
    message: string
    defaultPrompt?: string
    dialogType: string
  } | null>(null)
  const [dialogText, setDialogText] = useState("")
  const [upload, setUpload] = useState<{ multiple: boolean } | null>(null)
  const [downloads, setDownloads] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    navigate.current = onNavigate
  }, [onNavigate])

  const send = (message: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(message))
  }

  useEffect(() => {
    let cancelled = false
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let activeImage: ImageBitmap | null = null
    let sequence = 0
    let drawn = 0
    const connect = () => {
      if (cancelled) return
      const connection = webBrowserSocket()
      socket.current = connection
      connection.onopen = () => {
        if (cancelled) {
          connection.close()
          return
        }
        setConnected(true)
        setError(null)
        rememberWebBrowserTab(tab.id)
        connection.send(
          JSON.stringify({
            type: "open",
            tabId: tab.id,
            url: currentUrl.current,
            navigate: true,
          })
        )
      }
      connection.onmessage = async ({ data }) => {
        const message = JSON.parse(String(data))
        if (message.type === "frame") {
          const frameNumber = ++sequence
          const binary = atob(message.data)
          const bytes = Uint8Array.from(binary, (character) =>
            character.charCodeAt(0)
          )
          const image = await createImageBitmap(
            new Blob([bytes], { type: "image/jpeg" })
          )
          if (cancelled || frameNumber < drawn) {
            image.close()
            return
          }
          drawn = frameNumber
          activeImage?.close()
          activeImage = image
          const page = canvas.current
          if (page) {
            page.width = image.width
            page.height = image.height
            page.getContext("2d")?.drawImage(image, 0, 0)
            setPainted(true)
          }
        } else if (message.type === "state") {
          if (message.url === "about:blank") return
          currentUrl.current = message.url
          navigate.current(message.url)
          setHistory({ back: message.back, forward: message.forward })
          setBrowserTabState({
            tabId: browserTabBackendId(tab.id) ?? tab.id,
            ownerWindow: "main",
            kind: "page",
            surface: "child",
            channel: "degraded",
            channelError: null,
            url: message.url,
            requestedUrl: message.url,
            title: message.title,
            favicon: null,
            loading: false,
            canGoBack: message.back,
            canGoForward: message.forward,
            origin: new URL(message.url).origin,
            zoom: 1,
            error: null,
            remoteHost: null,
            openerTabId: null,
            profile: "default",
            agentGrant: null,
          })
        } else if (message.type === "error") setError(message.message)
        else if (message.type === "popup") setPopup(message.url)
        else if (message.type === "dialog") {
          setDialog(message)
          setDialogText(message.defaultPrompt || "")
        } else if (message.type === "upload")
          setUpload({ multiple: message.multiple })
        else if (message.type === "download")
          setDownloads((items) => [
            ...items,
            { id: message.id, name: message.name },
          ])
      }
      connection.onerror = () => setError("浏览器连接失败，正在重试")
      connection.onclose = ({ code }) => {
        if (cancelled) return
        setConnected(false)
        if (code === 4001)
          setError("此标签已在另一设备操作；点击重新连接可接管")
        else {
          setError("浏览器连接已断开，正在重连")
          reconnect = setTimeout(connect, 3000)
        }
      }
    }
    connect()
    return () => {
      cancelled = true
      clearTimeout(reconnect)
      socket.current?.close()
      activeImage?.close()
    }
  }, [tab.id, retry])

  useEffect(() => {
    if (url === currentUrl.current) return
    currentUrl.current = url
    setError(null)
    send({ type: "navigate", url })
  }, [url])

  useEffect(() => {
    if (reload.current === reloadKey) return
    reload.current = reloadKey
    send({ type: "reload" })
  }, [reloadKey])

  const device = emulatedViewport(tab.browser.device)
  const deviceWidth = device?.width
  const deviceHeight = device?.height
  useEffect(() => {
    const element = container.current
    if (!element || !connected) return
    let timer: ReturnType<typeof setTimeout>
    const resize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const rect = element.getBoundingClientRect()
        send({
          type: "resize",
          width: deviceWidth ?? Math.round(rect.width),
          height: deviceHeight ?? Math.round(rect.height),
          mobile: false,
        })
      }, 120)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [connected, deviceWidth, deviceHeight])

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const page = canvas.current!
    const rect = page.getBoundingClientRect()
    const scale = Math.min(rect.width / page.width, rect.height / page.height)
    return {
      x:
        (event.clientX - rect.left - (rect.width - page.width * scale) / 2) /
        scale,
      y: (event.clientY - rect.top) / scale,
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs">
        <button
          type="button"
          className={ICON_BTN}
          aria-label="后退"
          disabled={!history.back}
          onClick={() => send({ type: "history", direction: "back" })}
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          type="button"
          className={ICON_BTN}
          aria-label="前进"
          disabled={!history.forward}
          onClick={() => send({ type: "history", direction: "forward" })}
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          type="button"
          className={ICON_BTN}
          aria-label="刷新网站"
          onClick={() => {
            setError(null)
            send({ type: "reload" })
          }}
        >
          <RotateCw className="size-3.5" />
        </button>
        <span className="text-muted-foreground">
          {connected ? "在线浏览器" : "连接中"}
        </span>
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b px-3 py-2 text-xs"
        >
          <span className="flex-1">{error}</span>
          <button
            type="button"
            className="underline"
            onClick={() => setRetry((value) => value + 1)}
          >
            重新连接
          </button>
        </div>
      )}
      {popup && (
        <div
          role="status"
          className="flex items-center gap-2 border-b px-3 py-2 text-xs"
        >
          <span className="min-w-0 flex-1 truncate">网站请求打开：{popup}</span>
          <button
            type="button"
            className="underline"
            onClick={() => {
              navigate.current(popup)
              setPopup(null)
            }}
          >
            打开
          </button>
          <button
            type="button"
            aria-label="关闭新页面提示"
            onClick={() => setPopup(null)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {upload && (
        <div className="border-b px-3 py-2 text-xs">
          <button
            type="button"
            className="inline-flex items-center gap-1 underline"
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="size-3.5" />
            选择文件上传到网站
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple={upload?.multiple}
        onChange={(event) => {
          const files = Array.from(event.target.files || [])
          if (files.length)
            void uploadBrowserFiles(tab.id, files)
              .then(() => setUpload(null))
              .catch((failure) => setError(String(failure.message)))
          event.target.value = ""
        }}
      />
      {downloads.map((download) => (
        <button
          type="button"
          key={download.id}
          className="flex items-center gap-2 border-b px-3 py-2 text-left text-xs underline"
          onClick={() =>
            void downloadBrowserFile(tab.id, download.id, download.name).catch(
              (failure) => setError(String(failure.message))
            )
          }
        >
          <Download className="size-3.5" />
          下载 {download.name}
        </button>
      ))}
      {dialog && (
        <div
          role="dialog"
          aria-label="网站提示"
          className="border-b p-3 text-xs"
        >
          <p>{dialog.message}</p>
          {dialog.dialogType === "prompt" && (
            <input
              aria-label="网站提示输入"
              className="my-2 w-full rounded border p-1"
              value={dialogText}
              onChange={(event) => setDialogText(event.target.value)}
            />
          )}
          <div className="mt-2 flex gap-4">
            {[true, false].map((accept) => (
              <button
                type="button"
                className="underline"
                key={String(accept)}
                onClick={() => {
                  send({ type: "dialog", accept, text: dialogText })
                  setDialog(null)
                }}
              >
                {accept ? "确定" : "取消"}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        ref={container}
        className="relative flex min-h-0 flex-1 items-start justify-center overflow-hidden bg-white"
      >
        {!painted && (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-gray-600"
          >
            <Loader2 className="size-4 animate-spin" />
            正在加载网站
          </div>
        )}
        <canvas
          ref={canvas}
          aria-label="网站画面"
          className="max-h-full max-w-full touch-none object-contain outline-none"
          style={{
            width: "100%",
            height: "100%",
            objectPosition: "top center",
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            input.current?.focus({ preventScroll: true })
            send({
              type: "pointer",
              event: "mousePressed",
              ...point(event),
              button: ["left", "middle", "right"][event.button],
              buttons: event.buttons,
              modifiers: modifiers(event),
              count: event.detail,
            })
          }}
          onPointerUp={(event) => {
            send({
              type: "pointer",
              event: "mouseReleased",
              ...point(event),
              button: ["left", "middle", "right"][event.button],
              buttons: event.buttons,
              modifiers: modifiers(event),
              count: event.detail,
            })
            if (event.pointerType === "touch")
              input.current?.focus({ preventScroll: true })
          }}
          onPointerMove={(event) => {
            if (event.buttons || Date.now() - hoverAt.current > 70) {
              hoverAt.current = Date.now()
              send({
                type: "pointer",
                event: "mouseMoved",
                ...point(event),
                buttons: event.buttons,
                modifiers: modifiers(event),
              })
            }
          }}
          onWheel={(event) => {
            event.preventDefault()
            const page = canvas.current!,
              rect = page.getBoundingClientRect()
            const scale = Math.min(
              rect.width / page.width,
              rect.height / page.height
            )
            send({
              type: "pointer",
              event: "mouseWheel",
              x:
                (event.clientX -
                  rect.left -
                  (rect.width - page.width * scale) / 2) /
                scale,
              y: (event.clientY - rect.top) / scale,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              modifiers: modifiers(event),
            })
          }}
        />
        <textarea
          ref={input}
          aria-label="向网站输入文字"
          className="absolute bottom-0 left-0 h-px w-px resize-none opacity-0"
          autoComplete="off"
          onChange={(event) => {
            if (
              !(event.nativeEvent as InputEvent).isComposing &&
              event.target.value
            ) {
              send({ type: "text", text: event.target.value })
              event.target.value = ""
            }
          }}
          onCompositionEnd={(event) => {
            if (event.data) send({ type: "text", text: event.data })
            event.currentTarget.value = ""
          }}
          onPaste={(event) => {
            event.preventDefault()
            send({
              type: "text",
              text: event.clipboardData.getData("text/plain"),
            })
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.key === "Process" ||
              event.key === "Unidentified"
            )
              return
            if (
              event.key.length === 1 &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            )
              return
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "v"
            )
              return
            event.preventDefault()
            send({
              type: "key",
              event: "keyDown",
              key: event.key,
              code: event.code,
              keyCode: event.keyCode,
              modifiers: modifiers(event),
              ...((event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "a"
                ? { commands: ["selectAll"] }
                : {}),
            })
          }}
          onKeyUp={(event) => {
            if (event.key.length > 1)
              send({
                type: "key",
                event: "keyUp",
                key: event.key,
                code: event.code,
                keyCode: event.keyCode,
                modifiers: modifiers(event),
              })
          }}
        />
      </div>
    </div>
  )
}
