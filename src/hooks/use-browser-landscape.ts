"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

export function useBrowserLandscape() {
  const anchor = useRef<HTMLDivElement>(null)
  const [host] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div")
  )
  const [active, setActive] = useState(false)
  const wanted = useRef(false)
  const locked = useRef(false)
  const nativeFullscreen = useRef(false)
  const [size, setSize] = useState({ width: 0, height: 0, portrait: false })
  const attachAnchor = useCallback((node: HTMLDivElement | null) => {
    anchor.current = node
  }, [])

  const exit = useCallback(() => {
    wanted.current = false
    setActive(false)
    if (locked.current) screen.orientation?.unlock()
    locked.current = false
    if (
      nativeFullscreen.current &&
      document.fullscreenElement === document.documentElement
    )
      void document.exitFullscreen().catch(() => {})
    nativeFullscreen.current = false
  }, [])

  useEffect(() => {
    const measure = () => {
      const width = document.documentElement.clientWidth || window.innerWidth
      const height = window.visualViewport?.height || window.innerHeight
      setSize((previous) => ({
        width,
        height,
        // 键盘仅改变高度时不能误判方向，否则输入时画面会来回旋转。
        portrait: previous.width === width ? previous.portrait : width < height,
      }))
    }
    measure()
    window.addEventListener("resize", measure)
    window.visualViewport?.addEventListener("resize", measure)
    const fullscreenChange = () => {
      if (
        wanted.current &&
        document.fullscreenElement === document.documentElement
      )
        nativeFullscreen.current = true
      else if (nativeFullscreen.current) {
        nativeFullscreen.current = false
        exit()
      }
    }
    document.addEventListener("fullscreenchange", fullscreenChange)
    return () => {
      wanted.current = false
      window.removeEventListener("resize", measure)
      window.visualViewport?.removeEventListener("resize", measure)
      document.removeEventListener("fullscreenchange", fullscreenChange)
      if (locked.current) screen.orientation?.unlock()
      if (
        nativeFullscreen.current &&
        document.fullscreenElement === document.documentElement
      )
        void document.exitFullscreen().catch(() => {})
    }
  }, [exit, host])

  const rotated = active && size.portrait
  useLayoutEffect(() => {
    if (!host) return
    // 只移动同一个 Portal 宿主，横竖屏切换不能重建视频、连接或网页表单。
    const parent = active ? document.body : anchor.current
    if (parent && host.parentNode !== parent) parent.appendChild(host)
    Object.assign(host.style, {
      position: active ? "fixed" : "relative",
      left: "0",
      top: "0",
      width: active ? `${rotated ? size.height : size.width}px` : "100%",
      height: active ? `${rotated ? size.width : size.height}px` : "100%",
      zIndex: active ? "40" : "",
      transformOrigin: "top left",
      transform: rotated ? `translateX(${size.width}px) rotate(90deg)` : "",
      background: "var(--background)",
      overflow: "hidden",
    })
  }, [host, active, rotated, size.width, size.height])

  useEffect(() => () => host?.remove(), [host])

  const toggle = () => {
    if (active) {
      exit()
      return
    }
    if (!host) return
    wanted.current = true
    document.body.appendChild(host)
    setActive(true)
    // 原生全屏/方向锁不可用时，保留页面内旋转；不要求用户放开系统方向锁。
    let fullscreen: Promise<void> | undefined
    try {
      // 全屏整个文档，原有菜单 Portal 才不会被浏览器顶层遮住。
      fullscreen = document.documentElement.requestFullscreen?.()
    } catch {
      return
    }
    void Promise.resolve(fullscreen)
      .then(async () => {
        if (!wanted.current) return
        const orientation = screen.orientation as ScreenOrientation & {
          lock?: (direction: string) => Promise<void>
        }
        if (!orientation?.lock) return
        await orientation.lock("landscape")
        if (wanted.current) locked.current = true
        else orientation.unlock()
      })
      .catch(() => {})
  }

  return { anchor: attachAnchor, host, active, rotated, toggle }
}
