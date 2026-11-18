"use client"

import { useTranslations } from "next-intl"
import type { AppUpdateState } from "@/lib/updater"

const reasonKeys = {
  agent: "idleUpdate.agent",
  terminal: "idleUpdate.terminal",
  automation: "idleUpdate.automation",
  work_task: "idleUpdate.workTask",
  new_work: "idleUpdate.newWork",
  unknown: "idleUpdate.unknown",
} as const

export function IdleUpdateStatus({ state }: { state: AppUpdateState }) {
  const t = useTranslations("SystemSettings")
  if (state.status !== "waiting_for_idle") return null
  const countdown = state.restartCountdownSeconds
  return (
    <div role="status" className="space-y-1 text-xs text-muted-foreground">
      <p>
        {countdown === undefined
          ? t("idleUpdate.waiting")
          : t("idleUpdate.countdown", { seconds: countdown })}
      </p>
      {countdown === undefined &&
        [...new Set(state.blockers)].map((reason) => (
          <p key={reason} className="text-2xs">
            {t(
              Object.prototype.hasOwnProperty.call(reasonKeys, reason)
                ? reasonKeys[reason as keyof typeof reasonKeys]
                : reasonKeys.unknown
            )}
          </p>
        ))}
      <p className="text-2xs">{t("idleUpdate.hint")}</p>
    </div>
  )
}
