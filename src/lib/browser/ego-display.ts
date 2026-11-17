export function egoPagePoint(
  bounds: Pick<DOMRect, "left" | "right" | "top" | "width" | "height">,
  frame: { width: number; height: number },
  clientX: number,
  clientY: number,
  rotated: boolean
) {
  // 页面内横屏回退旋转了显示层，输入必须逆向旋转后交给真实页面。
  const horizontal = rotated
    ? (clientY - bounds.top) / bounds.height
    : (clientX - bounds.left) / bounds.width
  const vertical = rotated
    ? (bounds.right - clientX) / bounds.width
    : (clientY - bounds.top) / bounds.height
  return {
    x: Math.max(0, Math.min(frame.width - 1, horizontal * frame.width)),
    y: Math.max(0, Math.min(frame.height - 1, vertical * frame.height)),
  }
}
