import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { getWhaleBalanceLedger, tokenUsageReport } from "@/lib/api"
import { getTransport } from "@/lib/transport"
import type {
  TokenUsageReport,
  WhaleBalanceLedger,
  WhaleBalanceSnapshot,
} from "@/lib/types"
import { whaleDate, type WhaleOptions } from "@/lib/whale-widget"
import { useWhaleLabel } from "./whale-options-dialog"

type Quota = NonNullable<WhaleOptions["quotas"]>[string]
interface CodexUsage {
  tokens: number
  sessions: number
  truncated: boolean
  windows: { label: string; percent: number; resetsAt?: number }[]
}

function beijingStart(date: string) {
  return new Date(`${date}T00:00:00+08:00`).toISOString()
}

function quotaStart(quota: Quota, now: number) {
  const today = whaleDate(now)
  if (quota.reset === "monthly") return beijingStart(`${today.slice(0, 7)}-01`)
  if (quota.reset === "daily") return beijingStart(today)
  return quota.since
}

function getCodexUsage(start?: string, models?: string[]) {
  return getTransport().call<CodexUsage>("whale_widget_codex_usage", {
    input: { start, models },
  })
}

export function useWhaleQuota(
  quota: Quota | undefined,
  lastSuccess?: string | null
) {
  const [usage, setUsage] = useState<{ quota: Quota; used: number } | null>(
    null
  )
  useEffect(() => {
    if (!quota || quota.source === "manual") return
    let cancelled = false
    const start = quotaStart(quota, Date.now())
    const models = quota.models
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    const query =
      quota.source === "codex"
        ? getCodexUsage(start, models).then((result) =>
            result.truncated ? null : result.tokens
          )
        : tokenUsageReport({
            start,
            models,
            bucket: "day",
            tzOffsetMinutes: 480,
          }).then((result) =>
            result.truncated ? null : result.totals.total_tokens
          )
    void query
      .then((used) => {
        if (!cancelled) setUsage(used == null ? null : { quota, used })
      })
      .catch(() => {
        if (!cancelled) setUsage(null)
      })
    return () => {
      cancelled = true
    }
  }, [quota, lastSuccess])
  if (!quota) return null
  // eslint-disable-next-line react-hooks/purity -- 重置日期只是展示值，取当前时钟即可
  const now = Date.now()
  const start = quotaStart(quota, now)
  const used =
    quota.source === "manual"
      ? !start ||
        !quota.since ||
        quota.since >= start ||
        quota.reset === "never"
        ? quota.used
        : 0
      : usage?.quota === quota
        ? usage.used
        : null
  const today = whaleDate(now)
  const nextMonth = new Date(`${today.slice(0, 7)}-01T00:00:00Z`)
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
  return {
    total: quota.total,
    used,
    reset:
      quota.reset === "monthly"
        ? nextMonth.toISOString().slice(0, 10)
        : quota.reset === "daily"
          ? whaleDate(now + 86_400_000)
          : undefined,
  }
}

export function WhaleUsageDialog({
  snapshot,
  onClose,
}: {
  snapshot: WhaleBalanceSnapshot
  onClose: () => void
}) {
  const label = useWhaleLabel()
  const [range, setRange] = useState(1)
  const [filter, setFilter] = useState("")
  const [tab, setTab] = useState<"ledger" | "tokens" | "codex">("ledger")
  const [ledger, setLedger] = useState<WhaleBalanceLedger | null>(null)
  const [report, setReport] = useState<{
    range: number
    data: TokenUsageReport
  } | null>(null)
  const [codex, setCodex] = useState<{
    range: number
    data: CodexUsage
  } | null>(null)
  const [error, setError] = useState("")
  // eslint-disable-next-line react-hooks/purity -- 日期范围只用于展示和查询起点
  const now = Date.now()
  const today = whaleDate(now)
  const earliest = range ? whaleDate(now - (range - 1) * 86_400_000) : undefined

  useEffect(() => {
    let cancelled = false
    void getWhaleBalanceLedger()
      .then((value) => {
        if (!cancelled) setLedger(value)
      })
      .catch(() => {
        if (!cancelled) setError("ledger")
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (tab === "ledger") return
    let cancelled = false
    const start = earliest ? beijingStart(earliest) : undefined
    if (tab === "tokens")
      void tokenUsageReport({ start, bucket: "day", tzOffsetMinutes: 480 })
        .then((data) => {
          if (!cancelled) setReport({ range, data })
        })
        .catch(() => {
          if (!cancelled) setError("tokens")
        })
    if (tab === "codex")
      void getCodexUsage(start)
        .then((data) => {
          if (!cancelled) setCodex({ range, data })
        })
        .catch(() => {
          if (!cancelled) setError("codex")
        })
    return () => {
      cancelled = true
    }
  }, [earliest, range, tab])

  const lookup = new Map(
    snapshot.accounts?.map((account) => [
      account.id,
      account.accountName || account.id,
    ])
  )
  const query = filter.trim().toLowerCase()
  const matches = (value: string) => value.toLowerCase().includes(query)
  const dates = new Map<string, WhaleBalanceLedger["entries"]>()
  for (const entry of [...(ledger?.entries ?? [])].reverse()) {
    if (Number.isNaN(Date.parse(entry.at))) continue
    const date = whaleDate(entry.at)
    if (
      (!earliest || date >= earliest) &&
      matches(
        `${lookup.get(entry.modelId) ?? entry.modelId} ${entry.modelId} ${date} ${entry.note ?? ""}`
      )
    ) {
      const entries = dates.get(date) ?? []
      entries.push(entry)
      dates.set(date, entries)
    }
  }
  const consumption = Object.entries(ledger?.dailyConsumption ?? {})
    .map(([id, daily]) => ({
      id,
      name: lookup.get(id) ?? id,
      value: Object.entries(daily)
        .filter(
          ([day]) =>
            day <= today &&
            (!earliest || day >= earliest) &&
            matches(`${lookup.get(id) ?? id} ${id} ${day}`)
        )
        .reduce((sum, [, amount]) => sum + amount, 0),
    }))
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value)
  const currentReport = report?.range === range ? report.data : null
  const currentCodex = codex?.range === range ? codex.data : null
  const ready =
    tab === "ledger" ? ledger : tab === "tokens" ? currentReport : currentCodex

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-2xl gap-3">
        <DialogTitle>{label("小鲸鱼记账", "Whale usage records")}</DialogTitle>
        <div
          className="flex flex-wrap gap-1"
          aria-label={label("记录类型", "Record type")}
        >
          {Object.entries({
            ledger: label("余额观测", "Balance ledger"),
            tokens: label("模型 token", "Model tokens"),
            codex: label("Codex 本地", "Local Codex"),
          }).map(([key, title]) => (
            <Button
              type="button"
              size="sm"
              key={key}
              aria-pressed={tab === key}
              variant={tab === key ? "secondary" : "ghost"}
              onClick={() => {
                setTab(key as typeof tab)
                setError("")
              }}
            >
              {title}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              [1, label("今日", "Today")],
              [7, label("近 7 天", "Last 7 days")],
              [30, label("近 30 天", "Last 30 days")],
              [0, label("全部", "All")],
            ] as const
          ).map(([value, title]) => (
            <Button
              type="button"
              size="sm"
              key={value}
              aria-pressed={range === value}
              variant={range === value ? "secondary" : "ghost"}
              onClick={() => {
                setRange(value)
                setError("")
              }}
            >
              {title}
            </Button>
          ))}
          {tab !== "codex" && (
            <Input
              className="min-w-36 flex-1"
              aria-label={label("搜索日期或模型", "Search by date or model")}
              placeholder={label("搜索日期或模型", "Search by date or model")}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
        </div>
        {!ready && (
          <p
            className="text-sm text-muted-foreground"
            role={error === tab ? "alert" : "status"}
          >
            {error === tab
              ? label("读取记录失败", "Could not load records")
              : label("正在读取…", "Loading…")}
          </p>
        )}
        {tab === "ledger" && ledger && (
          <>
            {consumption.map((item) => (
              <div className="grid gap-1 text-sm" key={item.id}>
                <div className="flex justify-between gap-2">
                  <span>{item.name}</span>
                  <span className="tabular-nums">{item.value.toFixed(2)}</span>
                </div>
                <progress
                  className="h-1.5 w-full"
                  value={item.value}
                  max={consumption[0].value}
                />
              </div>
            ))}
            {[...dates]
              .sort(([left], [right]) => right.localeCompare(left))
              .map(([date, entries]) => (
                <details key={date} className="border-b pb-2 text-sm">
                  <summary className="cursor-pointer">
                    {date} · {entries.length}
                  </summary>
                  {entries.map((entry, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-[auto_1fr_auto] gap-2 py-1 text-xs"
                    >
                      <time dateTime={entry.at}>
                        {new Date(entry.at).toLocaleTimeString([], {
                          timeZone: "Asia/Shanghai",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                      <span>
                        {lookup.get(entry.modelId) ?? entry.modelId} ·{" "}
                        {
                          {
                            consumption: label("观测消费", "Observed spend"),
                            balance_increase: label(
                              "余额增加",
                              "Balance increase"
                            ),
                            reconciliation: label("校正", "Adjustment"),
                          }[entry.kind]
                        }
                        {entry.note && ` · ${entry.note}`}
                      </span>
                      <span className="tabular-nums">
                        {entry.amount.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </details>
              ))}
            {!dates.size && !consumption.length && (
              <p className="text-sm text-muted-foreground">
                {label("没有匹配记录", "No matching records")}
              </p>
            )}
          </>
        )}
        {tab === "tokens" && currentReport && (
          <>
            {currentReport.truncated && (
              <p className="text-sm text-muted-foreground">
                {label(
                  "记录过多，仅显示最近一部分。",
                  "Only the latest records are included."
                )}
              </p>
            )}
            <strong className="text-sm">
              {currentReport.totals.total_tokens.toLocaleString()} tokens
            </strong>
            {(query.match(/^\d{4}-/)
              ? []
              : currentReport.by_model.filter((item) => matches(item.label))
            ).map((item) => (
              <div key={item.key} className="grid gap-1 text-sm">
                <div className="flex justify-between gap-2">
                  <span>{item.label}</span>
                  <span>{item.total_tokens.toLocaleString()}</span>
                </div>
                <progress
                  className="h-1.5 w-full"
                  value={item.total_tokens}
                  max={Math.max(currentReport.totals.total_tokens, 1)}
                />
              </div>
            ))}
            {currentReport.series
              .filter(
                (item) => item.total_tokens > 0 && matches(item.bucket_key)
              )
              .slice()
              .reverse()
              .map((item) => (
                <div
                  key={item.bucket_key}
                  className="flex justify-between gap-2 border-b pb-1 text-sm"
                >
                  <time>{item.bucket_key}</time>
                  <span>{item.total_tokens.toLocaleString()}</span>
                </div>
              ))}
          </>
        )}
        {tab === "codex" && currentCodex && (
          <div className="grid gap-2 text-sm">
            <strong>
              {currentCodex.tokens.toLocaleString()} tokens ·{" "}
              {currentCodex.sessions.toLocaleString()}{" "}
              {label("个会话文件", "session files")}
            </strong>
            {currentCodex.truncated && (
              <span>
                {label(
                  "仅统计扫描限制内的文件。",
                  "Only files within the scan limit are included."
                )}
              </span>
            )}
            {currentCodex.windows.map((item) => (
              <div key={item.label}>
                {item.label} · {label("已用", "Used")} {item.percent}%
                {item.resetsAt
                  ? ` · ${new Date(item.resetsAt * 1000).toLocaleString()}`
                  : ""}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
