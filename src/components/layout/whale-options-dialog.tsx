import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  GripVertical,
  Play,
  Plus,
  Trash2,
  Upload,
} from "lucide-react"
import { useLocale } from "next-intl"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  DEFAULT_SNAP,
  EVENTS,
  MODULE_TYPES,
  parseWhaleOptions,
  type WhaleBubble,
  type WhaleEvent,
  type WhaleModule,
  type WhaleOptions,
} from "@/lib/whale-widget"
import { WhaleBubbleContent, playWhaleSound } from "./whale-bubbles"
import { DEFAULT_SECONDS } from "./use-whale-options"

type Label = (zh: string, en: string) => string
export function useWhaleLabel(): Label {
  const chinese = useLocale().startsWith("zh")
  return (zh, en) => (chinese ? zh : en)
}

export function whaleEventLabel(event: WhaleEvent, label: Label) {
  return {
    press: label("按压音效", "Press sounds"),
    complete: label("每轮消耗提示", "Turn completed"),
    question: label("等待回答", "Question pending"),
    permission: label("等待授权", "Approval pending"),
    low: label("余额不足", "Low balance"),
    budget: label("今日预算已达上限", "Daily budget reached"),
  }[event]
}

export const whaleField =
  "min-w-0 rounded-md border bg-background px-2 py-1 text-sm"
const newModule: WhaleModule = { type: "text", value: "" }

export function WhaleField({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <label className="grid gap-1 text-xs">
      {title}
      {children}
    </label>
  )
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  )
}

function reorder<Item>(items: Item[], from: number, to: number) {
  const next = [...items]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

function BubbleEditor({
  rows,
  onChange,
  options,
  onLibrary,
  label,
}: {
  rows: WhaleBubble
  onChange: (rows: WhaleBubble) => void
  options: WhaleOptions
  onLibrary: (module: WhaleModule) => void
  label: Label
}) {
  const image = (module: WhaleModule) =>
    module.type === "image" || module.type === "randomImage"
  const images =
    options.assets?.filter((asset) => asset.data.startsWith("data:image/")) ??
    []
  const drag = useRef<{ row: number; column?: number } | null>(null)
  const replace = (row: number, items: WhaleModule[]) =>
    onChange(
      rows.flatMap((existing, index) =>
        index === row ? (items.length ? [items] : []) : [existing]
      )
    )
  const moveModule = (
    fromRow: number,
    fromCol: number,
    toRow: number,
    toCol: number
  ) => {
    const source = rows[fromRow]?.[fromCol]
    if (!source) return
    if (fromRow === toRow) {
      replace(fromRow, reorder(rows[fromRow], fromCol, toCol))
      return
    }
    if (image(source) || rows[toRow].some(image) || rows[toRow].length >= 6)
      return
    onChange(
      rows
        .map((row, index) =>
          index === fromRow
            ? row.filter((_, col) => col !== fromCol)
            : index === toRow
              ? [...row.slice(0, toCol), source, ...row.slice(toCol)]
              : row
        )
        .filter((row) => row.length)
    )
  }
  return (
    <div className="grid gap-2">
      {rows.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className="grid gap-2 border-b pb-2"
          onDragOver={(event) => {
            if (drag.current) event.preventDefault()
          }}
          onDrop={(event) => {
            if (!drag.current) return
            event.preventDefault()
            const { row: from, column } = drag.current
            drag.current = null
            if (column == null) onChange(reorder(rows, from, rowIndex))
            else moveModule(from, column, rowIndex, row.length)
          }}
        >
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span
              draggable
              onDragStart={(event) => {
                drag.current = { row: rowIndex }
                event.dataTransfer.setData("text/plain", "row")
              }}
              onDragEnd={() => {
                drag.current = null
              }}
            >
              <GripVertical className="size-4 cursor-grab" />
            </span>
            {label("第", "Row ")}
            {rowIndex + 1}
            {label("行", "")}
            <IconButton
              label={label("上移行", "Move row up")}
              disabled={!rowIndex}
              onClick={() => onChange(reorder(rows, rowIndex, rowIndex - 1))}
            >
              <ArrowUp />
            </IconButton>
            <IconButton
              label={label("下移行", "Move row down")}
              disabled={rowIndex === rows.length - 1}
              onClick={() => onChange(reorder(rows, rowIndex, rowIndex + 1))}
            >
              <ArrowDown />
            </IconButton>
            <IconButton
              label={label("添加同一行模块", "Add inline module")}
              disabled={row.length >= 6 || row.some(image)}
              onClick={() => replace(rowIndex, [...row, newModule])}
            >
              <Plus />
            </IconButton>
          </div>
          {row.map((module, colIndex) => {
            const set = (patch: Partial<WhaleModule>) =>
              replace(
                rowIndex,
                row.map((current, index) =>
                  index === colIndex ? { ...current, ...patch } : current
                )
              )
            return (
              <details
                key={colIndex}
                className="rounded-md border px-2 py-1"
                onDragOver={(event) => {
                  if (drag.current?.column != null) event.preventDefault()
                }}
                onDrop={(event) => {
                  const item = drag.current
                  if (item?.column == null) return
                  event.stopPropagation()
                  event.preventDefault()
                  drag.current = null
                  moveModule(item.row, item.column, rowIndex, colIndex)
                }}
              >
                <summary
                  className="cursor-pointer text-sm"
                  draggable
                  onDragStart={(event) => {
                    drag.current = { row: rowIndex, column: colIndex }
                    event.dataTransfer.setData("text/plain", "module")
                  }}
                  onDragEnd={() => {
                    drag.current = null
                  }}
                >
                  {module.type} ·{" "}
                  {(module.value || `{${module.type}}`).slice(0, 45)}
                </summary>
                <div className="mt-2 grid gap-2">
                  <div className="flex flex-wrap items-center gap-1">
                    <select
                      aria-label={label("模块类型", "Module type")}
                      className={whaleField}
                      value={module.type}
                      onChange={(event) =>
                        set({
                          type: event.target.value as WhaleModule["type"],
                          value: "",
                        })
                      }
                    >
                      {MODULE_TYPES.map((type) => (
                        <option
                          key={type}
                          disabled={
                            type !== module.type &&
                            (type === "image" || type === "randomImage") &&
                            (row.length > 1 ||
                              rows.some(
                                (items, index) =>
                                  index !== rowIndex && items.some(image)
                              ))
                          }
                        >
                          {type}
                        </option>
                      ))}
                    </select>
                    <IconButton
                      label={label("模块前移", "Move module earlier")}
                      disabled={!colIndex}
                      onClick={() =>
                        replace(rowIndex, reorder(row, colIndex, colIndex - 1))
                      }
                    >
                      <ArrowUp />
                    </IconButton>
                    <IconButton
                      label={label("模块后移", "Move module later")}
                      disabled={colIndex === row.length - 1}
                      onClick={() =>
                        replace(rowIndex, reorder(row, colIndex, colIndex + 1))
                      }
                    >
                      <ArrowDown />
                    </IconButton>
                    <IconButton
                      label={label("加入模块库", "Save module to library")}
                      onClick={() => onLibrary(module)}
                    >
                      <BookOpen />
                    </IconButton>
                    <IconButton
                      label={label("删除模块", "Delete module")}
                      onClick={() =>
                        replace(
                          rowIndex,
                          row.filter((_, index) => index !== colIndex)
                        )
                      }
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                  {module.type === "image" ? (
                    <select
                      aria-label={label("图片", "Image")}
                      className={whaleField}
                      value={module.value}
                      onChange={(event) => set({ value: event.target.value })}
                    >
                      <option value="">
                        {label("选择图片", "Choose image")}
                      </option>
                      {images.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <WhaleField
                      title={
                        module.type.startsWith("random")
                          ? label(
                              "备选内容（每行：权重|内容）",
                              "Choices (one weight|value per line)"
                            )
                          : label("内容 / 占位符", "Content / placeholder")
                      }
                    >
                      <textarea
                        className={whaleField}
                        rows={module.type.startsWith("random") ? 3 : 1}
                        maxLength={1800}
                        value={module.value}
                        onChange={(event) => set({ value: event.target.value })}
                      />
                      {module.type === "randomImage" && (
                        <select
                          aria-label={label(
                            "加入备选图片",
                            "Add candidate image"
                          )}
                          className={whaleField}
                          value=""
                          onChange={(event) =>
                            set({
                              value: [module.value, `1|${event.target.value}`]
                                .filter(Boolean)
                                .join("\n"),
                            })
                          }
                        >
                          <option value="">
                            {label("加入图片", "Add image")}
                          </option>
                          {images.map((asset) => (
                            <option key={asset.id} value={asset.id}>
                              {asset.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </WhaleField>
                  )}
                  {module.type === "link" && (
                    <WhaleField title="URL">
                      <Input
                        type="url"
                        value={module.href ?? ""}
                        onChange={(event) => set({ href: event.target.value })}
                      />
                    </WhaleField>
                  )}
                  {!image(module) && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <WhaleField title={label("字号", "Size")}>
                        <Input
                          type="number"
                          min={10}
                          max={48}
                          value={module.size ?? ""}
                          onChange={(event) =>
                            set({
                              size: event.target.value
                                ? Number(event.target.value)
                                : undefined,
                            })
                          }
                        />
                      </WhaleField>
                      <WhaleField title={label("字体", "Font")}>
                        <Input
                          value={module.font ?? ""}
                          onChange={(event) =>
                            set({ font: event.target.value })
                          }
                        />
                      </WhaleField>
                      {(["color", "gradient", "background"] as const).map(
                        (key) => (
                          <WhaleField
                            key={key}
                            title={
                              {
                                color: label("文字颜色", "Text color"),
                                gradient: label("渐变色", "Gradient"),
                                background: label("底色", "Background"),
                              }[key]
                            }
                          >
                            <div className="flex gap-1">
                              <input
                                type="color"
                                value={module[key] || "#536ba9"}
                                onChange={(event) =>
                                  set({ [key]: event.target.value })
                                }
                              />
                              {module[key] && (
                                <button
                                  type="button"
                                  onClick={() => set({ [key]: "" })}
                                  aria-label={label("清除颜色", "Clear color")}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          </WhaleField>
                        )
                      )}
                      {(["bold", "italic", "underline"] as const).map((key) => (
                        <label
                          key={key}
                          className="flex items-center gap-2 text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={module[key] ?? false}
                            onChange={(event) =>
                              set({ [key]: event.target.checked })
                            }
                          />
                          {
                            {
                              bold: label("粗体", "Bold"),
                              italic: label("斜体", "Italic"),
                              underline: label("下划线", "Underline"),
                            }[key]
                          }
                        </label>
                      ))}
                      {module.type === "session" && (
                        <WhaleField
                          title={label("保留长度", "Maximum title length")}
                        >
                          <Input
                            type="number"
                            min={0}
                            max={200}
                            value={module.limit ?? 0}
                            onChange={(event) =>
                              set({ limit: Number(event.target.value) })
                            }
                          />
                        </WhaleField>
                      )}
                    </div>
                  )}
                </div>
              </details>
            )
          })}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rows.length >= 6}
          onClick={() => onChange([...rows, [newModule]])}
        >
          <Plus />
          {label("添加行", "Add row")}
        </Button>
        {!!options.library?.length && (
          <select
            aria-label={label("从模块库添加", "Add from library")}
            className={whaleField}
            value=""
            disabled={rows.length >= 6}
            onChange={(event) => {
              const picked = options.library?.[Number(event.target.value)]
              if (
                picked &&
                (!image(picked) || !rows.some((row) => row.some(image)))
              )
                onChange([...rows, [picked]])
            }}
          >
            <option value="">
              {label("从模块库添加", "Add from library")}
            </option>
            {options.library.map((module, index) => (
              <option key={index} value={index}>
                {module.type} · {module.value.slice(0, 30)}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

export function WhaleOptionsDialog({
  options,
  onSave,
  onClose,
  modelId,
  balanceLabel,
  turnModels,
}: {
  options: WhaleOptions
  onSave: (options: WhaleOptions) => Promise<void>
  onClose: () => void
  modelId: string
  balanceLabel: string
  turnModels?: string[]
}) {
  const label = useWhaleLabel()
  const [draft, setDraft] = useState(options)
  const [tab, setTab] = useState("bubble")
  const [priceModel, setPriceModel] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const stopAudio = useRef<() => void>(undefined)
  useEffect(() => () => stopAudio.current?.(), [])
  const apply = (patch: Partial<WhaleOptions>) =>
    setDraft((previous) => ({ ...previous, ...patch }))
  const library = (module: WhaleModule) =>
    apply({ library: [...(draft.library ?? []), module].slice(-40) })
  const snap = draft.snap ?? DEFAULT_SNAP
  const sequence = draft.sequence ?? []
  const assets = draft.assets ?? []
  const audio = assets.filter((item) => item.data.startsWith("data:audio/"))
  const image = assets.filter((item) => item.data.startsWith("data:image/"))
  const alert = draft.alerts?.[modelId]
  const quota = draft.quotas?.[modelId]
  const price = draft.prices?.[priceModel]
  const setQuota = (patch: Partial<NonNullable<typeof quota>>) =>
    apply({
      quotas: {
        ...draft.quotas,
        [modelId]: {
          total: 1,
          source: "manual",
          reset: "never",
          used: 0,
          models: "",
          since: new Date().toISOString(),
          ...quota,
          ...patch,
        },
      },
    })
  const setPrice = (patch: Partial<NonNullable<typeof price>>) =>
    apply({
      prices: {
        ...draft.prices,
        [priceModel]: {
          input: 0,
          cache: 0,
          output: 0,
          exchange: 1,
          ...price,
          ...patch,
        },
      },
    })
  const setSequence = (index: number, next: (typeof sequence)[number]) =>
    apply({
      sequence: sequence.map((entry, at) => (at === index ? next : entry)),
    })
  const soundSelect = (
    value: string | undefined,
    onChange: (value: string) => void
  ) => (
    <select
      className={whaleField}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{label("静音", "Silent")}</option>
      <option value="tone:high">{label("高音提示", "High chime")}</option>
      <option value="tone:low">{label("低音提示", "Low chime")}</option>
      {audio.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </select>
  )
  const importAsset = async (file: File) => {
    if (file.size > 700_000 || assets.length >= 40) {
      setError(
        label(
          "单个素材不得超过 700 KB，最多 40 个。",
          "Assets are limited to 700 KB each and 40 items."
        )
      )
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      try {
        apply(
          parseWhaleOptions({
            assets: [
              ...assets,
              {
                id: crypto.randomUUID(),
                name: file.name.slice(0, 160),
                data: reader.result,
              },
            ],
          })
        )
        setError("")
      } catch {
        setError(label("不支持这个素材格式。", "Unsupported asset format."))
      }
    }
    reader.onerror = () =>
      setError(label("读取素材失败。", "Could not read the asset."))
    reader.readAsDataURL(file)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent className="max-w-2xl gap-3">
        <DialogTitle>
          {label("小鲸鱼挂件设置", "Whale widget settings")}
        </DialogTitle>
        <nav
          aria-label={label("挂件设置分类", "Widget settings sections")}
          className="flex flex-wrap gap-1 border-b pb-2"
        >
          {Object.entries({
            bubble: label("泡泡", "Bubbles"),
            events: label("音效与提示", "Sounds & alerts"),
            movement: label("吸附与菜单", "Snapping & menu"),
            assets: label("素材", "Assets"),
            quota: label("额度与单价", "Quota & prices"),
          }).map(([key, title]) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={tab === key ? "secondary" : "ghost"}
              aria-pressed={tab === key}
              onClick={() => {
                stopAudio.current?.()
                setTab(key)
              }}
            >
              {title}
            </Button>
          ))}
        </nav>
        {tab === "bubble" && (
          <div className="grid gap-3">
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={!draft.hideBubble}
                onChange={(event) =>
                  apply({ hideBubble: !event.target.checked })
                }
              />
              {label("显示气泡", "Show bubbles")}
            </label>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.advanceOnAvatar ?? false}
                onChange={(event) =>
                  apply({ advanceOnAvatar: event.target.checked })
                }
              />
              {label("点按角色推进泡泡队列", "Advance bubbles on avatar click")}
            </label>
            {sequence.map((choices, index) => (
              <details key={index} className="rounded-md border px-3 py-2">
                <summary className="cursor-pointer text-sm">
                  {index
                    ? `${label("再次点击", "Next click")} ${index}`
                    : label("首次点击", "First click")}{" "}
                  · {choices.length}
                </summary>
                <div className="my-2 flex gap-1">
                  <IconButton
                    label={label("上移泡泡", "Move bubble up")}
                    disabled={!index}
                    onClick={() =>
                      apply({ sequence: reorder(sequence, index, index - 1) })
                    }
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label={label("下移泡泡", "Move bubble down")}
                    disabled={index === sequence.length - 1}
                    onClick={() =>
                      apply({ sequence: reorder(sequence, index, index + 1) })
                    }
                  >
                    <ArrowDown />
                  </IconButton>
                  <IconButton
                    label={label("删除泡泡", "Delete bubble")}
                    onClick={() =>
                      apply({
                        sequence: sequence.filter((_, at) => at !== index),
                      })
                    }
                  >
                    <Trash2 />
                  </IconButton>
                </div>
                {choices.map((choice, choiceIndex) => (
                  <div key={choiceIndex} className="mb-2 border-t pt-2">
                    <div className="mb-2 flex items-end gap-2">
                      <WhaleField
                        title={`${label("权重", "Weight")} ${choiceIndex + 1}`}
                      >
                        <Input
                          className="w-24"
                          type="number"
                          min={1}
                          max={100}
                          value={choice.weight}
                          onChange={(event) =>
                            setSequence(
                              index,
                              choices.map((current, at) =>
                                at === choiceIndex
                                  ? {
                                      ...current,
                                      weight: Number(event.target.value),
                                    }
                                  : current
                              )
                            )
                          }
                        />
                      </WhaleField>
                      <IconButton
                        label={label("删除并列泡泡", "Delete variation")}
                        disabled={choices.length <= 1}
                        onClick={() =>
                          setSequence(
                            index,
                            choices.filter((_, at) => at !== choiceIndex)
                          )
                        }
                      >
                        <Trash2 />
                      </IconButton>
                    </div>
                    <BubbleEditor
                      rows={choice.rows}
                      onChange={(rows) =>
                        setSequence(
                          index,
                          choices.map((current, at) =>
                            at === choiceIndex ? { ...current, rows } : current
                          )
                        )
                      }
                      options={draft}
                      onLibrary={library}
                      label={label}
                    />
                    <div className="mt-2 rounded-md border bg-muted/40 p-2">
                      <WhaleBubbleContent
                        rows={choice.rows}
                        options={draft}
                        values={{
                          balance: "703.13",
                          session: balanceLabel,
                          today: "12.34",
                          cost: "0.0250",
                        }}
                      />
                    </div>
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={choices.length >= 6}
                  onClick={() =>
                    setSequence(index, [
                      ...choices,
                      { weight: 1, rows: [[newModule]] },
                    ])
                  }
                >
                  <Plus />
                  {label("添加并列泡泡", "Add weighted variation")}
                </Button>
              </details>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="justify-self-start"
              disabled={sequence.length >= 24}
              onClick={() =>
                apply({
                  sequence: [...sequence, [{ weight: 1, rows: [[newModule]] }]],
                })
              }
            >
              <Plus />
              {label("添加点击泡泡", "Add click bubble")}
            </Button>
            {!!draft.library?.length && (
              <details>
                <summary className="cursor-pointer text-sm">
                  {label("模块库", "Module library")} · {draft.library.length}
                </summary>
                {draft.library.map((module, index) => (
                  <div
                    className="flex items-center justify-between text-sm"
                    key={index}
                  >
                    {module.type} · {module.value.slice(0, 40)}
                    <IconButton
                      label={label("移除库模块", "Remove library module")}
                      onClick={() =>
                        apply({
                          library: draft.library?.filter(
                            (_, at) => at !== index
                          ),
                        })
                      }
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                ))}
              </details>
            )}
          </div>
        )}
        {tab === "events" && (
          <div className="grid gap-2">
            {EVENTS.map((event) => {
              const config = draft.events?.[event]
              const update = (patch: Partial<NonNullable<typeof config>>) =>
                apply({
                  events: { ...draft.events, [event]: { ...config, ...patch } },
                })
              const volume =
                config?.volume ?? draft.events?.press?.volume ?? 100
              return (
                <details className="rounded-md border px-3 py-2" key={event}>
                  <summary className="cursor-pointer text-sm">
                    {whaleEventLabel(event, label)} ·{" "}
                    {config?.enabled ? `${volume}%` : label("关闭", "Off")}
                  </summary>
                  <div className="mt-2 grid gap-2">
                    <label className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={config?.enabled ?? false}
                        onChange={(input) =>
                          update({ enabled: input.target.checked })
                        }
                      />
                      {label("启用", "Enable")}
                    </label>
                    {(event === "low" || event === "budget") && (
                      <WhaleField
                        title={`${balanceLabel} · ${label("阈值", "Threshold")}`}
                      >
                        <Input
                          type="number"
                          min={0}
                          step="any"
                          value={alert?.[event] ?? ""}
                          onChange={(input) =>
                            apply({
                              alerts: {
                                ...draft.alerts,
                                [modelId]: {
                                  ...alert,
                                  [event]:
                                    input.target.value === ""
                                      ? null
                                      : Number(input.target.value),
                                },
                              },
                            })
                          }
                        />
                      </WhaleField>
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                      <WhaleField
                        title={
                          event === "press"
                            ? label("按下音效", "Press sound")
                            : label("提示音", "Sound")
                        }
                      >
                        {soundSelect(config?.sound, (sound) =>
                          update({ sound })
                        )}
                      </WhaleField>
                      <IconButton
                        label={label("试听", "Preview")}
                        onClick={() => {
                          stopAudio.current?.()
                          stopAudio.current = playWhaleSound(
                            draft,
                            config?.sound,
                            volume
                          )
                        }}
                      >
                        <Play />
                      </IconButton>
                      {event === "press" && (
                        <WhaleField title={label("松开音效", "Release sound")}>
                          {soundSelect(config?.release, (release) =>
                            update({ release })
                          )}
                        </WhaleField>
                      )}
                      {event === "press" && (
                        <IconButton
                          label={label("试听松开音效", "Preview release sound")}
                          onClick={() => {
                            stopAudio.current?.()
                            stopAudio.current = playWhaleSound(
                              draft,
                              config?.release,
                              volume
                            )
                          }}
                        >
                          <Play />
                        </IconButton>
                      )}
                      <WhaleField
                        title={`${label("音量", "Volume")} ${volume}%`}
                      >
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={volume}
                          onChange={(input) =>
                            update({ volume: Number(input.target.value) })
                          }
                        />
                      </WhaleField>
                      {event !== "press" && config?.volume != null && (
                        <Button
                          size="sm"
                          variant="ghost"
                          type="button"
                          onClick={() => update({ volume: undefined })}
                        >
                          {label("跟随按压音量", "Follow press volume")}
                        </Button>
                      )}
                      {event !== "press" && (
                        <WhaleField
                          title={label(
                            "自动关闭秒数（0 为不关闭）",
                            "Auto-close seconds (0 = never)"
                          )}
                        >
                          <Input
                            type="number"
                            min={0}
                            max={3600}
                            value={config?.seconds ?? DEFAULT_SECONDS}
                            onChange={(input) =>
                              update({ seconds: Number(input.target.value) })
                            }
                          />
                        </WhaleField>
                      )}
                    </div>
                    {event !== "press" && (
                      <BubbleEditor
                        rows={config?.bubble ?? []}
                        onChange={(bubble) => update({ bubble })}
                        options={draft}
                        onLibrary={library}
                        label={label}
                      />
                    )}
                  </div>
                </details>
              )
            })}
          </div>
        )}
        {tab === "movement" && (
          <div className="grid gap-3">
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.hideMenu ?? false}
                onChange={(event) => apply({ hideMenu: event.target.checked })}
              />
              {label("隐藏菜单按钮", "Hide menu button")}
            </label>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.avoidScrollbar ?? false}
                onChange={(event) =>
                  apply({ avoidScrollbar: event.target.checked })
                }
              />
              {label("避让滚动条", "Avoid scrollbar")}
            </label>
            <WhaleField title={label("吸附区单位", "Snap-zone unit")}>
              <select
                className={whaleField}
                value={snap.mode}
                onChange={(event) =>
                  apply({
                    snap: {
                      ...snap,
                      mode: event.target.value as typeof snap.mode,
                    },
                  })
                }
              >
                <option value="ratio">
                  {label("比例（%）", "Percentage")}
                </option>
                <option value="pixels">{label("像素", "Pixels")}</option>
              </select>
            </WhaleField>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(["left", "right", "top", "bottom"] as const).map((edge) => (
                <WhaleField
                  key={edge}
                  title={
                    {
                      left: label("左", "Left"),
                      right: label("右", "Right"),
                      top: label("上", "Top"),
                      bottom: label("下", "Bottom"),
                    }[edge]
                  }
                >
                  <Input
                    type="number"
                    min={0}
                    max={snap.mode === "ratio" ? 50 : 1000}
                    value={snap[edge]}
                    onChange={(event) =>
                      apply({
                        snap: {
                          ...snap,
                          [edge]: Math.min(
                            snap.mode === "ratio" ? 50 : 1000,
                            Math.max(0, Number(event.target.value))
                          ),
                        },
                      })
                    }
                  />
                </WhaleField>
              ))}
            </div>
          </div>
        )}
        {tab === "assets" && (
          <div className="grid gap-3">
            <WhaleField title={label("当前角色", "Active character")}>
              <select
                className={whaleField}
                value={draft.role ?? ""}
                onChange={(event) => apply({ role: event.target.value })}
              >
                <option value="">{label("默认小鲸鱼", "Default whale")}</option>
                {image.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </WhaleField>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <Upload className="size-4" />
              {label("导入图片或音频", "Import image or audio")}
              <input
                type="file"
                accept="image/png,image/gif,image/jpeg,image/webp,audio/wav,audio/mpeg,audio/ogg,audio/mp4,audio/webm"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void importAsset(file)
                  event.target.value = ""
                }}
              />
            </label>
            {[
              [label("图片", "Images"), image],
              [label("音频片段", "Audio clips"), audio],
            ].map(([title, items]) => (
              <details
                key={String(title)}
                className="rounded-md border px-3 py-2"
              >
                <summary className="cursor-pointer text-sm">
                  {String(title)} · {(items as typeof assets).length}
                </summary>
                {(items as typeof assets).map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-2 border-t py-2 text-sm"
                  >
                    {item.data.startsWith("data:image/") ? (
                      <img
                        src={item.data}
                        alt=""
                        className="size-9 object-contain"
                      />
                    ) : (
                      <IconButton
                        label={label("试听", "Preview")}
                        onClick={() => {
                          stopAudio.current?.()
                          stopAudio.current = playWhaleSound(
                            draft,
                            item.id,
                            100
                          )
                        }}
                      >
                        <Play />
                      </IconButton>
                    )}
                    <span className="min-w-0 flex-1 wrap-anywhere">
                      {item.name}
                    </span>
                    {item.data.startsWith("data:audio/") &&
                      (["from", "to"] as const).map((key) => (
                        <WhaleField
                          key={key}
                          title={
                            key === "from"
                              ? label("起点（秒）", "Start (s)")
                              : label("终点（秒）", "End (s)")
                          }
                        >
                          <Input
                            className="w-20"
                            type="number"
                            min={0}
                            step="0.1"
                            value={item[key] ?? ""}
                            onChange={(event) =>
                              apply({
                                assets: assets.map((asset) =>
                                  asset.id === item.id
                                    ? {
                                        ...asset,
                                        [key]: event.target.value
                                          ? Number(event.target.value)
                                          : undefined,
                                      }
                                    : asset
                                ),
                              })
                            }
                          />
                        </WhaleField>
                      ))}
                    <IconButton
                      label={label("移除素材", "Remove asset")}
                      onClick={() => {
                        stopAudio.current?.()
                        apply({
                          assets: assets.filter(
                            (asset) => asset.id !== item.id
                          ),
                          role: draft.role === item.id ? undefined : draft.role,
                        })
                      }}
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                ))}
              </details>
            ))}
          </div>
        )}
        {tab === "quota" && (
          <div className="grid gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(quota)}
                onChange={(event) => {
                  if (event.target.checked) setQuota({})
                  else {
                    const next = { ...draft.quotas }
                    delete next[modelId]
                    apply({ quotas: next })
                  }
                }}
              />
              {balanceLabel} · {label("额度", "Quota")}
            </label>
            {quota && (
              <div className="grid grid-cols-2 gap-2">
                <WhaleField title={label("额度来源", "Usage source")}>
                  <select
                    className={whaleField}
                    value={quota.source}
                    onChange={(event) =>
                      setQuota({
                        source: event.target.value as typeof quota.source,
                      })
                    }
                  >
                    <option value="manual">{label("手动", "Manual")}</option>
                    <option value="indexed">
                      {label("Codeg 会话 token", "Codeg session tokens")}
                    </option>
                    <option value="codex">
                      {label("Codex 本地 token", "Local Codex tokens")}
                    </option>
                  </select>
                </WhaleField>
                <WhaleField title={label("总量", "Total")}>
                  <Input
                    type="number"
                    min={0.01}
                    step="any"
                    value={quota.total}
                    onChange={(event) =>
                      setQuota({ total: Number(event.target.value) })
                    }
                  />
                </WhaleField>
                {quota.source === "manual" ? (
                  <WhaleField title={label("已用", "Used")}>
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={quota.used}
                      onChange={(event) =>
                        setQuota({
                          used: Number(event.target.value),
                          since: new Date().toISOString(),
                        })
                      }
                    />
                  </WhaleField>
                ) : (
                  <WhaleField
                    title={label(
                      "模型筛选（逗号分隔）",
                      "Models (comma-separated)"
                    )}
                  >
                    <Input
                      value={quota.models}
                      onChange={(event) =>
                        setQuota({ models: event.target.value })
                      }
                    />
                  </WhaleField>
                )}
                <WhaleField title={label("重置周期", "Reset cycle")}>
                  <select
                    className={whaleField}
                    value={quota.reset}
                    onChange={(event) =>
                      setQuota({
                        reset: event.target.value as typeof quota.reset,
                      })
                    }
                  >
                    <option value="never">{label("不重置", "Never")}</option>
                    <option value="daily">{label("每日", "Daily")}</option>
                    <option value="monthly">{label("每月", "Monthly")}</option>
                  </select>
                </WhaleField>
                {quota.source !== "manual" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setQuota({ since: new Date().toISOString() })
                    }
                  >
                    {label("重设累计基准", "Reset usage baseline")}
                  </Button>
                )}
              </div>
            )}
            <WhaleField title={label("逐轮计价模型", "Per-turn pricing model")}>
              <Input
                list="whale-usage-models"
                value={priceModel}
                onChange={(event) => setPriceModel(event.target.value)}
              />
              <datalist id="whale-usage-models">
                {[
                  ...new Set([
                    ...(turnModels ?? []),
                    ...Object.keys(draft.prices ?? {}),
                  ]),
                ].map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </WhaleField>
            {priceModel && (
              <div className="grid grid-cols-2 gap-2">
                {(["input", "cache", "output", "exchange"] as const).map(
                  (key) => (
                    <WhaleField
                      key={key}
                      title={
                        {
                          input: label("输入 / 百万", "Input / million"),
                          cache: label(
                            "缓存命中 / 百万",
                            "Cache hit / million"
                          ),
                          output: label("输出 / 百万", "Output / million"),
                          exchange: label("兑人民币汇率", "CNY exchange rate"),
                        }[key]
                      }
                    >
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        value={price?.[key] ?? ""}
                        onChange={(event) =>
                          setPrice({ [key]: Number(event.target.value) })
                        }
                      />
                    </WhaleField>
                  )
                )}
                {price && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const next = { ...draft.prices }
                      delete next[priceModel]
                      apply({ prices: next })
                    }}
                  >
                    {label("移除单价", "Remove price")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setDraft({ assets: draft.assets })
              setError("")
            }}
          >
            {label("恢复默认", "Restore defaults")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onClose}
          >
            {label("取消", "Cancel")}
          </Button>
          <Button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true)
              setError("")
              void onSave(draft)
                .then(onClose)
                .catch(() =>
                  setError(
                    label(
                      "保存失败。检查数值范围或素材总大小（约 1 MB 原始文件）。",
                      "Save failed. Check value ranges and total asset size (about 1 MB of source files)."
                    )
                  )
                )
                .finally(() => setSaving(false))
            }}
          >
            {label("保存", "Save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
