import { codegAuthHeaders, getCodegToken } from "@/lib/transport/web-auth"
import { buildCodegWebSocketProtocols } from "@/lib/transport/ws-auth"

const openTabs = new Set<string>()

export function rememberWebBrowserTab(tab: string) {
  openTabs.add(tab)
}

export function closeWebBrowserTab(tab: string) {
  if (!openTabs.delete(tab)) return
  void fetch(`${webBrowserOrigin()}/close?tab=${encodeURIComponent(tab)}`, {
    method: "POST",
    headers: codegAuthHeaders(getCodegToken()),
    keepalive: true,
  }).catch(() => {})
}

export function webBrowserOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_CODEG_BROWSER_URL ||
    `${window.location.origin}/__codeg_browser`
  ).replace(/\/$/, "")
}

export function webBrowserSocket(): WebSocket {
  const url = new URL(`${webBrowserOrigin()}/socket`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const socket = new WebSocket(url, [
    "codeg-browser",
    ...buildCodegWebSocketProtocols(getCodegToken()).slice(1),
  ])
  socket.binaryType = "arraybuffer"
  return socket
}

export async function webBrowserDevtools(tab: string): Promise<string> {
  const response = await fetch(
    `${webBrowserOrigin()}/devtools-entry?tab=${encodeURIComponent(tab)}`,
    { method: "POST", headers: codegAuthHeaders(getCodegToken()) }
  )
  if (!response.ok) throw new Error("开发者工具连接失败")
  return (await response.json()).url
}

export async function uploadBrowserFiles(tab: string, files: File[]) {
  const total = files.reduce((size, file) => size + file.size, 0)
  if (total > 16 * 1024 * 1024) throw new Error("单次上传不能超过 16 MB")
  const encoded = await Promise.all(
    files.map(
      (file) =>
        new Promise<{ name: string; data: string }>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () =>
            resolve({
              name: file.name,
              data: String(reader.result).split(",")[1],
            })
          reader.onerror = () => reject(new Error("文件读取失败"))
          reader.readAsDataURL(file)
        })
    )
  )
  const response = await fetch(
    `${webBrowserOrigin()}/upload?tab=${encodeURIComponent(tab)}`,
    {
      method: "POST",
      headers: {
        ...codegAuthHeaders(getCodegToken()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ files: encoded }),
    }
  )
  if (!response.ok) throw new Error((await response.json()).error)
}

export async function downloadBrowserFile(
  tab: string,
  id: string,
  name: string
) {
  const response = await fetch(
    `${webBrowserOrigin()}/download?tab=${encodeURIComponent(tab)}&id=${encodeURIComponent(id)}`,
    { headers: codegAuthHeaders(getCodegToken()) }
  )
  if (!response.ok) throw new Error("下载失败，请重新连接浏览器")
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
