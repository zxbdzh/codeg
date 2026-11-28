import { useEffect, useState } from "react"

const PANEL_SLIDE_MS = 240
const PANEL_SLIDE_CLEANUP_MS = PANEL_SLIDE_MS + 60

/** 只为当前页面内的开关变化播放动画；换页时直接建立新基线。 */
export function usePanelSlideOnToggle(
  open: boolean,
  ready: boolean,
  scope: boolean = true
): boolean {
  const [animating, setAnimating] = useState(false)
  const [slideSeq, setSlideSeq] = useState(0)
  const [previous, setPrevious] = useState<{
    open: boolean
    scope: boolean
  } | null>(null)

  if (ready) {
    if (previous === null || previous.scope !== scope) {
      // 页面恢复尺寸不是手动展开；同时取消快速往返时尚未结束的动画。
      setPrevious({ open, scope })
      setAnimating(false)
    } else if (previous.open !== open) {
      setPrevious({ open, scope })
      setAnimating(true)
      setSlideSeq((seq) => seq + 1)
    }
  }

  useEffect(() => {
    if (slideSeq === 0) return
    const timer = setTimeout(() => setAnimating(false), PANEL_SLIDE_CLEANUP_MS)
    return () => clearTimeout(timer)
  }, [slideSeq])

  return animating
}
