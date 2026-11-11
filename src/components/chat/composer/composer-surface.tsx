import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"
import { composerBoxMinHeight } from "./composer-sizing"

type ComposerSurfaceProps = ComponentProps<"div"> & {
  attached?: boolean
  activeFlow?: boolean
  dragActive?: boolean
  tall?: boolean
}

export function ComposerSurface({
  attached = false,
  activeFlow = false,
  dragActive = false,
  tall = false,
  className,
  ...props
}: ComposerSurfaceProps) {
  return (
    <div
      className={cn(
        "codeg-composer-chrome @container relative flex flex-col rounded-xl border border-foreground/20 bg-transparent transition-colors",
        composerBoxMinHeight(tall),
        // 与文件夹栏连为一体时使用内描边，避免外层裁切焦点环。
        attached
          ? "bg-background ws-transparent-bg focus-within:border-ring focus-within:ring-[3px] focus-within:ring-inset focus-within:ring-ring/50"
          : "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        activeFlow && "codeg-composer-flow",
        !attached && dragActive && "ring-1 ring-primary/40",
        className
      )}
      {...props}
    />
  )
}

export function ComposerToolbar({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-end justify-between gap-1 px-2 pb-2",
        className
      )}
      {...props}
    />
  )
}
