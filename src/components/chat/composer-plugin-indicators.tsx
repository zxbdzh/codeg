"use client"

import { useEffect, useState, type ComponentType } from "react"
import { Brain, Scissors, type LucideProps } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { acpListAgentPluginIndicators } from "@/lib/api"
import type { AgentPluginIndicator, AgentType } from "@/lib/types"
import { cn } from "@/lib/utils"

type PluginId = AgentPluginIndicator["id"]
type IndicatorIcon = ComponentType<LucideProps>

const PLUGIN_ICONS: Record<PluginId, IndicatorIcon> = {
  "i-have-adhd": Brain,
  ponytail: Scissors,
}

function getStateLabel(
  indicator: AgentPluginIndicator,
  t: ReturnType<typeof useTranslations<"Folder.statusBar.plugins">>
): string {
  if (indicator.enabled === false) return t("states.disabled")
  if (indicator.enabled === null || indicator.state === "unknown")
    return t("states.unknown")
  if (indicator.state === "always_on_configured")
    return t("states.alwaysOnConfigured")
  if (indicator.state === "off") return t("states.off")
  if (indicator.state === "lite") return t("states.lite")
  if (indicator.state === "full") return t("states.full")
  return t("states.ultra")
}

function getSourceLabel(
  source: AgentPluginIndicator["source"],
  t: ReturnType<typeof useTranslations<"Folder.statusBar.plugins">>
): string {
  switch (source) {
    case "always_on_config":
      return t("sources.alwaysOnConfig")
    case "session_state_unobservable":
      return t("sources.sessionStateUnobservable")
    case "project_mode_marker":
      return t("sources.projectModeMarker")
    case "shared_mode_marker":
      return t("sources.sharedModeMarker")
    case "plugin_disabled":
      return t("sources.pluginDisabled")
  }
}

function getScopeLabel(
  scope: AgentPluginIndicator["scope"],
  t: ReturnType<typeof useTranslations<"Folder.statusBar.plugins">>
): string {
  switch (scope) {
    case "user":
      return t("scopes.user")
    case "session":
      return t("scopes.session")
    case "project_shared":
      return t("scopes.projectShared")
    case "user_shared":
      return t("scopes.userShared")
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right break-words">{value}</dd>
    </div>
  )
}

export function ComposerPluginIndicators({
  agentType,
  workspacePath,
  className,
}: {
  agentType: AgentType | null | undefined
  workspacePath?: string | null
  className?: string
}) {
  const t = useTranslations("Folder.statusBar.plugins")
  const [snapshot, setSnapshot] = useState<{
    key: string
    indicators: AgentPluginIndicator[]
  } | null>(null)
  const requestKey = agentType ? `${agentType}|${workspacePath ?? ""}` : null

  useEffect(() => {
    let current = true
    if (!agentType || !requestKey) return
    void acpListAgentPluginIndicators({
      agentType,
      workspacePath,
    }).then(
      (result) => {
        if (current) setSnapshot({ key: requestKey, indicators: result })
      },
      () => {
        if (current) setSnapshot({ key: requestKey, indicators: [] })
      }
    )

    return () => {
      current = false
    }
  }, [agentType, requestKey, workspacePath])

  const indicators = snapshot?.key === requestKey ? snapshot.indicators : null
  if (!indicators?.length) return null

  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      {indicators.map((indicator) => {
        const Icon = PLUGIN_ICONS[indicator.id]
        const stateLabel = getStateLabel(indicator, t)
        const name =
          indicator.id === "i-have-adhd" ? t("adhdName") : t("ponytailName")
        const chipLabel =
          indicator.id === "i-have-adhd"
            ? t("chipAdhd", { status: stateLabel })
            : t("chipPonytail", { status: stateLabel })
        const isOn =
          indicator.enabled === true &&
          (indicator.state === "always_on_configured" ||
            indicator.state === "lite" ||
            indicator.state === "full" ||
            indicator.state === "ultra")
        return (
          <Popover key={indicator.id}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`${name}: ${stateLabel}`}
                title={`${name}: ${stateLabel}`}
                className="inline-flex size-10 touch-manipulation items-center justify-center gap-1 rounded-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:size-8"
              >
                <Icon
                  className="size-4 shrink-0 md:size-3.5"
                  aria-hidden="true"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    isOn
                      ? "bg-emerald-500"
                      : indicator.enabled === false
                        ? "bg-muted-foreground/40"
                        : "bg-amber-500/70"
                  )}
                />
                <span className="sr-only">{chipLabel}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="bottom"
              align="end"
              className="w-[min(18rem,calc(100vw-1rem))] gap-2.5 p-3"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Icon className="size-3.5" aria-hidden="true" />
                <span>{name}</span>
              </div>
              <dl className="space-y-2">
                <DetailRow label={t("statusLabel")} value={stateLabel} />
                <DetailRow
                  label={t("sourceLabel")}
                  value={getSourceLabel(indicator.source, t)}
                />
                <DetailRow
                  label={t("scopeLabel")}
                  value={getScopeLabel(indicator.scope, t)}
                />
              </dl>
            </PopoverContent>
          </Popover>
        )
      })}
    </div>
  )
}
