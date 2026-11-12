"use client"

/**
 * The extra tools codeg hands an agent inside a conversation, as one panel:
 * live feedback, ask-user-question, get-session-info, the built-in browser
 * (and, inside it, running code), and the two create-from-chat writers. All of
 * them are injected by `codeg-mcp` when an agent starts, so what the user is
 * really deciding here is one thing — how much of the app an agent may reach
 * from a conversation.
 *
 * They used to be four sections, each with its own heading, description, card
 * and Save bar: four times the chrome for five switches, which is what made
 * `/settings/general` read as far longer than it configures. It now sits on
 * `/settings/collaboration` under the delegation panel it shares a companion
 * process with.
 *
 * The names, one-liners and icons come from `lib/agent-tool-groups`, shared
 * with the status-bar codeg-mcp popover — the two lists are the same switches
 * and had drifted into calling three of them by different names.
 *
 * Persistence stays split the way the backend has it — `feedback.enabled`,
 * `question.enabled`, `session_info.enabled`, `browser_tools.*`,
 * `computer_tools.enabled` and `chat_authoring.*` remain six endpoints. Save
 * writes only the groups whose value actually moved, so a
 * failing endpoint can't roll back its neighbours, and a group whose *load*
 * failed (its switch is showing a default, not what is stored) is left alone
 * unless the user touched it.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Wrench } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  AGENT_TOOLS_NAMESPACE,
  AGENT_TOOL_GROUPS,
} from "@/lib/agent-tool-groups"
import { subscribe } from "@/lib/platform"
import {
  BROWSER_TOOLS_SETTINGS_CHANGED_EVENT,
  CHAT_AUTHORING_SETTINGS_CHANGED_EVENT,
  QUESTION_SETTINGS_CHANGED_EVENT,
} from "@/lib/types"
import {
  getComputerToolsSettings,
  setComputerToolsEnabled,
} from "@/lib/computer/computer-api"
import {
  COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
  type ComputerToolsSettings,
} from "@/lib/computer/types"
import {
  getBrowserToolsSettings,
  getChatAuthoringSettings,
  getFeedbackSettings,
  getQuestionSettings,
  getSessionInfoSettings,
  setBrowserToolsSettings,
  setChatAuthoringSettings,
  setFeedbackSettings,
  setQuestionSettings,
  setSessionInfoSettings,
  type BrowserToolsSettings,
  type ChatAuthoringSettings,
  type QuestionSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { primeFeedbackEnabled } from "@/hooks/use-feedback-enabled"

/** One field per switch, flattened across the five backend groups. */
interface AgentToolValues {
  feedback: boolean
  question: boolean
  questionTimeoutMode: "permanent" | "custom"
  // 保留输入原文，清空或越界时禁止保存，而不是悄悄转换成永久等待。
  questionTimeoutMinutes: string
  sessionInfo: boolean
  browserTools: boolean
  browserEval: boolean
  computer: boolean
  automations: boolean
  workTasks: boolean
}

/**
 * What the switches show until the load lands — and what a group that failed to
 * load keeps showing. Mirrors the Rust-side defaults (the two read-only lookups
 * ship on; feedback and the two writers ship off), so the panel doesn't flip
 * under the user a beat after it opens.
 */
const DEFAULTS: AgentToolValues = {
  feedback: false,
  question: true,
  questionTimeoutMode: "permanent",
  questionTimeoutMinutes: "",
  sessionInfo: true,
  browserTools: false,
  browserEval: false,
  computer: false,
  automations: false,
  workTasks: false,
}

/** The rows, in the order they read: what an agent may say to you, what it may
 *  look up, what it may do with the browser, what it may write.
 *
 *  Presentation (name, one-liner, paragraph, icon, which switch gates which)
 *  comes from `lib/agent-tool-groups`, which the status-bar codeg-mcp popover
 *  reads too — the two surfaces had drifted into calling three of the same
 *  switches by different names, and one table is the only fix that stays
 *  fixed. What lives here is the half that is this panel's own: which field of
 *  the form each slug edits, and the element id its label points at. */
const TOOL_ROWS = [
  { key: "feedback", slug: "feedback", id: "agent-tools-feedback" },
  { key: "question", slug: "ask", id: "agent-tools-question" },
  { key: "sessionInfo", slug: "sessions", id: "agent-tools-session-info" },
  { key: "browserTools", slug: "browser", id: "agent-tools-browser" },
  { key: "browserEval", slug: "browser_eval", id: "agent-tools-browser-eval" },
  { key: "computer", slug: "computer", id: "agent-tools-computer" },
  { key: "automations", slug: "automations", id: "agent-tools-automations" },
  { key: "workTasks", slug: "taskboard", id: "agent-tools-work-tasks" },
] as const satisfies ReadonlyArray<{
  key: keyof AgentToolValues
  slug: string
  id: string
}>

/** Slug → the form field it edits, for resolving a `requires` relation (which
 *  is expressed in slugs, because the backend sends it that way) back to a
 *  row of this form. */
const FIELD_OF_SLUG: Record<
  string,
  (typeof TOOL_ROWS)[number]["key"] | undefined
> = Object.fromEntries(TOOL_ROWS.map((row) => [row.slug, row.key]))

const QUESTION_TIMEOUT_MAX = 10080

type QuestionTimeoutValues = Pick<
  AgentToolValues,
  "questionTimeoutMode" | "questionTimeoutMinutes"
>

function questionTimeoutValues(minutes: number): QuestionTimeoutValues {
  return {
    questionTimeoutMode: minutes === 0 ? "permanent" : "custom",
    questionTimeoutMinutes: minutes === 0 ? "" : String(minutes),
  }
}

function questionTimeoutDirty(
  current: QuestionTimeoutValues,
  base: QuestionTimeoutValues
): boolean {
  return (
    current.questionTimeoutMode !== base.questionTimeoutMode ||
    (current.questionTimeoutMode === "custom" &&
      current.questionTimeoutMinutes !== base.questionTimeoutMinutes)
  )
}

export function AgentToolsSettingsSection() {
  const t = useTranslations("AgentToolsSettings")
  const tools = useTranslations(AGENT_TOOLS_NAMESPACE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [values, setValues] = useState<AgentToolValues>(DEFAULTS)
  // Last known-good values: set from a successful load, and per group from a
  // successful write. The diff against `values` is what Save acts on.
  const [baseline, setBaseline] = useState<AgentToolValues>(DEFAULTS)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Read through refs so the subscription below can compare `values` against
  // `baseline` without re-subscribing on every state change.
  const valuesRef = useRef(values)
  const baselineRef = useRef(baseline)
  useEffect(() => {
    valuesRef.current = values
    baselineRef.current = baseline
  }, [values, baseline])
  /** Bumped by every broadcast, one count per settings record. The initial
   * load samples them before its reads and, for a record whose count moved
   * while they were in flight, yields that record's fields to the broadcast —
   * that read is older than it. A broadcast about one record says nothing
   * about another's read. */
  const remoteGenRef = useRef({ question: 0, chat: 0, browser: 0, computer: 0 })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const gen = { ...remoteGenRef.current }
      const [feedback, question, sessionInfo, browserTools, computer, chat] =
        await Promise.allSettled([
          getFeedbackSettings(),
          getQuestionSettings(),
          getSessionInfoSettings(),
          getBrowserToolsSettings(),
          getComputerToolsSettings(),
          getChatAuthoringSettings(),
        ])
      if (cancelled) return

      // One endpoint being down shouldn't blank the other four switches, so
      // each group lands on its own and only the failures are reported.
      const next = { ...DEFAULTS }
      const failures: string[] = []
      if (feedback.status === "fulfilled")
        next.feedback = feedback.value.enabled
      else failures.push(toErrorMessage(feedback.reason))
      if (question.status === "fulfilled") {
        next.question = question.value.enabled
        Object.assign(
          next,
          questionTimeoutValues(question.value.timeout_minutes)
        )
      } else failures.push(toErrorMessage(question.reason))
      if (sessionInfo.status === "fulfilled")
        next.sessionInfo = sessionInfo.value.enabled
      else failures.push(toErrorMessage(sessionInfo.reason))
      if (browserTools.status === "fulfilled") {
        next.browserTools = browserTools.value.enabled
        next.browserEval = browserTools.value.eval
      } else failures.push(toErrorMessage(browserTools.reason))
      if (computer.status === "fulfilled")
        next.computer = computer.value.enabled
      else failures.push(toErrorMessage(computer.reason))
      if (chat.status === "fulfilled") {
        next.automations = chat.value.automations_enabled
        next.workTasks = chat.value.work_tasks_enabled
      } else failures.push(toErrorMessage(chat.reason))

      const moved = remoteGenRef.current
      // `prev` already holds the broadcast's value for the fields a broadcast
      // carried (or the user's pending edit, in `values`), so keeping it is
      // the merge. These are exactly the switches the status-bar popover can
      // also write — a read that started before that write is older than it.
      const keepBroadcast = (prev: AgentToolValues): AgentToolValues => ({
        ...next,
        // 读取期间收到的提问广播更新了整条记录，不能被较旧的读取结果盖回。
        ...(moved.question !== gen.question
          ? {
              question: prev.question,
              questionTimeoutMode: prev.questionTimeoutMode,
              questionTimeoutMinutes: prev.questionTimeoutMinutes,
            }
          : {}),
        ...(moved.chat !== gen.chat
          ? { automations: prev.automations, workTasks: prev.workTasks }
          : {}),
        ...(moved.browser !== gen.browser
          ? { browserTools: prev.browserTools, browserEval: prev.browserEval }
          : {}),
        ...(moved.computer !== gen.computer ? { computer: prev.computer } : {}),
      })
      setValues(keepBroadcast)
      setBaseline(keepBroadcast)
      setLoadError(failures.length > 0 ? failures.join("; ") : null)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Converge on a create-from-chat write that happened elsewhere.
   *
   * The status-bar codeg-mcp popover carries the same two switches, and the
   * save below writes the pair whenever *either* is dirty. Without this, a
   * form left open since before that popover toggle would submit its stale
   * value for the switch the user never touched and silently revert it.
   *
   * A switch the user *has* moved keeps their pending value — only the
   * baseline follows the remote, so the row stays dirty and their edit still
   * wins on save.
   */
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<ChatAuthoringSettings>(
      CHAT_AUTHORING_SETTINGS_CHANGED_EVENT,
      (remote) => {
        remoteGenRef.current.chat += 1
        const incoming = {
          automations: remote.automations_enabled,
          workTasks: remote.work_tasks_enabled,
        }
        const current = valuesRef.current
        const base = baselineRef.current
        setValues((prev) => ({
          ...prev,
          ...(current.automations === base.automations
            ? { automations: incoming.automations }
            : {}),
          ...(current.workTasks === base.workTasks
            ? { workTasks: incoming.workTasks }
            : {}),
        }))
        setBaseline((prev) => ({ ...prev, ...incoming }))
      }
    )
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      // Transport not ready is not a reason to break the form; it just means
      // this window keeps whatever it loaded.
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  /**
   * The same convergence for the two browser switches, which are two keys of
   * one record and now have the same two editors: this form, which writes the
   * pair, and the popover, which writes one key. Without it a form left open
   * since before a popover toggle submits its stale value for the switch the
   * user never touched and silently reverts it.
   */
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<BrowserToolsSettings>(
      BROWSER_TOOLS_SETTINGS_CHANGED_EVENT,
      (remote) => {
        remoteGenRef.current.browser += 1
        const incoming = {
          browserTools: remote.enabled,
          browserEval: remote.eval,
        }
        const current = valuesRef.current
        const base = baselineRef.current
        setValues((prev) => ({
          ...prev,
          ...(current.browserTools === base.browserTools
            ? { browserTools: incoming.browserTools }
            : {}),
          ...(current.browserEval === base.browserEval
            ? { browserEval: incoming.browserEval }
            : {}),
        }))
        setBaseline((prev) => ({ ...prev, ...incoming }))
      }
    )
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  /**
   * And for the computer-use switch, which the popover writes too. Only the
   * switch is this form's: the grant timeout and the blocklist in the same
   * record belong to the Computer use section and are never sent from here.
   */
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<ComputerToolsSettings>(
      COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
      (remote) => {
        remoteGenRef.current.computer += 1
        const current = valuesRef.current
        const base = baselineRef.current
        setValues((prev) =>
          current.computer === base.computer
            ? { ...prev, computer: remote.enabled }
            : prev
        )
        setBaseline((prev) => ({ ...prev, computer: remote.enabled }))
      }
    )
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<QuestionSettings>(
      QUESTION_SETTINGS_CHANGED_EVENT,
      (remote) => {
        if (disposed) return
        remoteGenRef.current.question += 1
        const incoming = {
          question: remote.enabled,
          ...questionTimeoutValues(remote.timeout_minutes),
        }
        // 先快照旧基线再同步 ref，连续广播也按字段保留草稿；开关与期限互不覆盖。
        const base = baselineRef.current
        baselineRef.current = { ...base, ...incoming }
        setValues((prev) => ({
          ...prev,
          ...(prev.question === base.question
            ? { question: incoming.question }
            : {}),
          ...(!questionTimeoutDirty(prev, base)
            ? questionTimeoutValues(remote.timeout_minutes)
            : {}),
        }))
        setBaseline((prev) => ({ ...prev, ...incoming }))
      }
    )
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  const timeoutDirty = questionTimeoutDirty(values, baseline)
  const timeoutMinutes = Number(values.questionTimeoutMinutes)
  const invalidTimeout =
    values.questionTimeoutMode === "custom" &&
    (!/^\d+$/.test(values.questionTimeoutMinutes) ||
      !Number.isInteger(timeoutMinutes) ||
      timeoutMinutes < 1 ||
      timeoutMinutes > QUESTION_TIMEOUT_MAX)

  const dirty =
    values.feedback !== baseline.feedback ||
    values.question !== baseline.question ||
    timeoutDirty ||
    values.sessionInfo !== baseline.sessionInfo ||
    values.browserTools !== baseline.browserTools ||
    values.browserEval !== baseline.browserEval ||
    values.computer !== baseline.computer ||
    values.automations !== baseline.automations ||
    values.workTasks !== baseline.workTasks

  const save = useCallback(async () => {
    if (invalidTimeout) return
    setSaving(true)
    const questionGen = remoteGenRef.current.question
    try {
      const writes: Array<Promise<Partial<AgentToolValues>>> = []

      if (values.feedback !== baseline.feedback) {
        writes.push(
          setFeedbackSettings({ enabled: values.feedback }).then((applied) => {
            // Refresh the module-cached flag so open conversations show/hide
            // the feedback bar without a full reload.
            primeFeedbackEnabled(applied.enabled)
            return { feedback: applied.enabled }
          })
        )
      }
      if (values.question !== baseline.question || timeoutDirty) {
        writes.push(
          setQuestionSettings({
            enabled: values.question,
            // 仅修改开关时不回写期限，其他入口或窗口刚保存的期限应由后端保留。
            ...(timeoutDirty
              ? {
                  timeout_minutes:
                    values.questionTimeoutMode === "permanent"
                      ? 0
                      : timeoutMinutes,
                }
              : {}),
          }).then((applied) => ({
            question: applied.enabled,
            ...questionTimeoutValues(applied.timeout_minutes),
          }))
        )
      }
      if (values.sessionInfo !== baseline.sessionInfo) {
        writes.push(
          setSessionInfoSettings({ enabled: values.sessionInfo }).then(
            (applied) => ({ sessionInfo: applied.enabled })
          )
        )
      }
      if (
        values.browserTools !== baseline.browserTools ||
        values.browserEval !== baseline.browserEval
      ) {
        writes.push(
          setBrowserToolsSettings({
            enabled: values.browserTools,
            // What the row shows while the group is off, sent as what it
            // shows. The backend drops it too; agreeing with it here is what
            // keeps the switch from springing back on after a save.
            eval: values.browserEval && values.browserTools,
          }).then((applied) => ({
            browserTools: applied.enabled,
            browserEval: applied.eval,
          }))
        )
      }
      if (values.computer !== baseline.computer) {
        // The switch alone: the same record's timeout and blocklist are the
        // Computer use section's to write.
        writes.push(
          setComputerToolsEnabled(values.computer).then((applied) => ({
            computer: applied.enabled,
          }))
        )
      }
      if (
        values.automations !== baseline.automations ||
        values.workTasks !== baseline.workTasks
      ) {
        writes.push(
          setChatAuthoringSettings({
            automations_enabled: values.automations,
            work_tasks_enabled: values.workTasks,
          }).then((applied) => ({
            automations: applied.automations_enabled,
            workTasks: applied.work_tasks_enabled,
          }))
        )
      }

      const results = await Promise.allSettled(writes)
      // Mirror what each endpoint actually persisted (it may clamp or filter)
      // and promote it to the new baseline; a group that failed keeps its old
      // baseline, so the next Save retries exactly that group.
      const applied = results.reduce<Partial<AgentToolValues>>(
        (acc, result) =>
          result.status === "fulfilled" ? { ...acc, ...result.value } : acc,
        {}
      )
      if (
        "question" in applied &&
        remoteGenRef.current.question !== questionGen
      ) {
        // 保存答复可能晚于更新的广播；以后端按提交顺序广播的最新基线为准。
        const latest = baselineRef.current
        Object.assign(applied, {
          question: latest.question,
          questionTimeoutMode: latest.questionTimeoutMode,
          questionTimeoutMinutes: latest.questionTimeoutMinutes,
        })
      }
      setValues((prev) => ({ ...prev, ...applied }))
      setBaseline((prev) => ({ ...prev, ...applied }))

      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => toErrorMessage(result.reason))
      if (failures.length > 0) {
        toast.error(t("saveFailed"), { description: failures.join("; ") })
      } else {
        toast.success(t("saved"))
      }
    } finally {
      setSaving(false)
    }
  }, [values, baseline, invalidTimeout, timeoutDirty, timeoutMinutes, t])

  return (
    <SettingsSection
      icon={Wrench}
      title={t("title")}
      description={t("description")}
    >
      {loadError && (
        <SettingsError>{t("loadFailed", { detail: loadError })}</SettingsError>
      )}

      {/* One card, because these are one decision split by which surface the
          agent reaches: the conversation, the app state behind it, or the page
          on screen next to it. */}
      <SettingCard>
        {TOOL_ROWS.map((row) => {
          const meta = AGENT_TOOL_GROUPS[row.slug]
          if (!meta) return null
          // A row that only means anything while another is on: shown off and
          // not touchable until it is.
          const gate = meta.requires ? FIELD_OF_SLUG[meta.requires] : undefined
          const available = !gate || values[gate]
          return (
            <Fragment key={row.key}>
              <SettingRow
                icon={meta.icon}
                title={tools(meta.label)}
                description={tools(meta.hint)}
                htmlFor={row.id}
                control={
                  <Switch
                    id={row.id}
                    checked={values[row.key] && available}
                    onCheckedChange={(next) =>
                      setValues((prev) => ({ ...prev, [row.key]: next }))
                    }
                    // 保存期间不接收草稿，避免被保存答复无声覆盖。
                    disabled={loading || saving || !available}
                  />
                }
              />
              {row.key === "question" && (
                <SettingRow
                  title={t("questionTimeout")}
                  description={
                    <span id="agent-tools-question-timeout-hint">
                      {t("questionTimeoutDescription")}
                    </span>
                  }
                  htmlFor="agent-tools-question-timeout-mode"
                  control={
                    <Select
                      value={values.questionTimeoutMode}
                      onValueChange={(next) =>
                        setValues((prev) => ({
                          ...prev,
                          questionTimeoutMode:
                            next === "custom" ? "custom" : "permanent",
                        }))
                      }
                      disabled={loading || saving}
                    >
                      <SelectTrigger
                        id="agent-tools-question-timeout-mode"
                        size="sm"
                        aria-describedby="agent-tools-question-timeout-hint"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="permanent">
                          {t("questionTimeoutPermanent")}
                        </SelectItem>
                        <SelectItem value="custom">
                          {t("questionTimeoutCustom")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  }
                >
                  {values.questionTimeoutMode === "custom" && (
                    <div className="flex flex-col gap-1.5">
                      <label
                        htmlFor="agent-tools-question-timeout-minutes"
                        className="text-xs text-muted-foreground"
                      >
                        {t("questionTimeoutMinutes")}
                      </label>
                      <Input
                        id="agent-tools-question-timeout-minutes"
                        type="number"
                        min={1}
                        max={QUESTION_TIMEOUT_MAX}
                        step={1}
                        className="h-8 w-32"
                        value={values.questionTimeoutMinutes}
                        onChange={(event) =>
                          setValues((prev) => ({
                            ...prev,
                            questionTimeoutMinutes: event.target.value,
                          }))
                        }
                        disabled={loading || saving}
                        aria-invalid={invalidTimeout}
                        aria-describedby={
                          invalidTimeout
                            ? "agent-tools-question-timeout-error"
                            : "agent-tools-question-timeout-hint"
                        }
                      />
                      {invalidTimeout && (
                        <p
                          id="agent-tools-question-timeout-error"
                          role="alert"
                          className="text-xs text-destructive"
                        >
                          {t("questionTimeoutInvalid")}
                        </p>
                      )}
                    </div>
                  )}
                </SettingRow>
              )}
            </Fragment>
          )
        })}
      </SettingCard>

      <SettingsSaveBar
        onSave={() => void save()}
        saving={saving}
        disabled={loading || !dirty || invalidTimeout}
        label={t("save")}
        savingLabel={t("saving")}
      />
    </SettingsSection>
  )
}
