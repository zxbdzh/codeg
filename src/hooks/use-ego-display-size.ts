"use client"

import { useEffect, useState } from "react"

export function useEgoDisplaySize(enabled: boolean) {
  const [size, setSize] = useState({
    width: 390,
    height: 844,
    deviceWidth: 390,
    deviceHeight: 844,
    portrait: true,
  })
  useEffect(() => {
    if (!enabled) return
    const viewport = window.visualViewport
    let layoutWidth = window.innerWidth
    let portrait = window.innerHeight > layoutWidth
    const update = () => {
      // 方向锁的返回或键盘高度变化不代表页面已转向；只有布局宽度变化后才更新方向。
      if (layoutWidth !== window.innerWidth) {
        layoutWidth = window.innerWidth
        portrait = window.innerHeight > layoutWidth
      }
      // 键盘只改变可见区域；真实页面宽度取设备短边，避免输入时反复重排。
      const next = {
        width: Math.round(viewport?.width ?? window.innerWidth),
        height: Math.round(viewport?.height ?? window.innerHeight),
        deviceWidth: Math.round(
          Math.min(
            window.screen.width || window.innerWidth,
            window.screen.height || window.innerWidth,
            window.innerWidth
          )
        ),
        deviceHeight: Math.round(
          Math.max(
            window.screen.width || window.innerWidth,
            window.screen.height || window.innerHeight
          )
        ),
        portrait,
      }
      setSize((previous) =>
        previous.width === next.width &&
        previous.height === next.height &&
        previous.deviceWidth === next.deviceWidth &&
        previous.deviceHeight === next.deviceHeight &&
        previous.portrait === next.portrait
          ? previous
          : next
      )
    }
    update()
    window.addEventListener("resize", update)
    window.addEventListener("orientationchange", update)
    window.screen.orientation?.addEventListener("change", update)
    viewport?.addEventListener("resize", update)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("orientationchange", update)
      window.screen.orientation?.removeEventListener("change", update)
      viewport?.removeEventListener("resize", update)
    }
  }, [enabled])
  return size
}
