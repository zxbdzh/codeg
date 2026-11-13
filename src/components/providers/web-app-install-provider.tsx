"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { isDesktop } from "@/lib/transport"

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

interface InstallEnvironment {
  secure: boolean
  ios: boolean
  standalone: boolean
}

interface WebAppInstallState extends InstallEnvironment {
  installed: boolean
  canInstall: boolean
  status: "idle" | "prompting" | "accepted" | "error"
  install: () => Promise<void>
}

const WebAppInstallContext = createContext<WebAppInstallState | null>(null)

export function WebAppInstallProvider({ children }: { children: ReactNode }) {
  const [environment, setEnvironment] = useState<InstallEnvironment | null>(
    null
  )
  const [canInstall, setCanInstall] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [status, setStatus] = useState<WebAppInstallState["status"]>("idle")
  const promptRef = useRef<InstallPromptEvent | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    if (isDesktop()) return
    const display = window.matchMedia("(display-mode: standalone)")
    const appleNavigator = navigator as Navigator & { standalone?: boolean }
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    const updateDisplay = () => {
      setEnvironment({
        secure: window.isSecureContext,
        ios,
        standalone: display.matches || appleNavigator.standalone === true,
      })
    }
    const capturePrompt = (event: Event) => {
      if (!window.isSecureContext) return
      if (!("prompt" in event) || typeof event.prompt !== "function") return
      event.preventDefault()
      promptRef.current = event as InstallPromptEvent
      setCanInstall(true)
      setStatus("idle")
    }
    const completeInstall = () => {
      promptRef.current = null
      setCanInstall(false)
      setInstalled(true)
      setStatus("idle")
    }
    updateDisplay()
    // 安装事件可能早于进入设置页；在根布局捕获，跨页面保留一次性提示。
    window.addEventListener("beforeinstallprompt", capturePrompt)
    window.addEventListener("appinstalled", completeInstall)
    display.addEventListener("change", updateDisplay)
    return () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt)
      window.removeEventListener("appinstalled", completeInstall)
      display.removeEventListener("change", updateDisplay)
    }
  }, [])

  const install = useCallback(async () => {
    const prompt = promptRef.current
    if (!prompt || busyRef.current) return
    busyRef.current = true
    // 同一个浏览器事件只能调用一次，拒绝后等待浏览器重新发出安装事件。
    promptRef.current = null
    setCanInstall(false)
    setStatus("prompting")
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      setStatus(choice.outcome === "accepted" ? "accepted" : "idle")
    } catch {
      setStatus("error")
    } finally {
      busyRef.current = false
    }
  }, [])

  const value = useMemo(
    () =>
      environment
        ? {
            ...environment,
            installed: installed || environment.standalone,
            canInstall,
            status,
            install,
          }
        : null,
    [environment, installed, canInstall, status, install]
  )

  return (
    <WebAppInstallContext.Provider value={value}>
      {children}
    </WebAppInstallContext.Provider>
  )
}

export function useWebAppInstall() {
  return useContext(WebAppInstallContext)
}
