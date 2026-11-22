"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Copy,
  ExternalLink,
  KeyRound,
  Keyboard,
  MoreVertical,
  RotateCw,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  useOptionalWorkspaceActions,
  type BrowserWorkspaceTab,
} from "@/contexts/workspace-context"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  browserCapabilities,
  browserGoBack,
  browserGoForward,
  browserNavigate,
  browserOpenDevtools,
  browserReload,
  browserStop,
} from "@/lib/browser/browser-api"
import { BrowserEgoImportDialog } from "./browser-ego-import"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import {
  DEFAULT_BROWSER_PROFILE_ID,
  useBrowserPrefs,
} from "@/lib/browser/browser-prefs"
import { clearBrowserAgentActivity } from "@/lib/browser/browser-tab-store"
import {
  isBlankPageUrl,
  normalizeTypedAddress,
} from "@/lib/browser/browser-url"
import {
  isRemoteHostAddress,
  remoteHostAddress,
} from "@/lib/browser/remote-host"
import type {
  BrowserTabState,
  GrantLevel,
  PageHandoff,
} from "@/lib/browser/types"
import { browserTabBackendId } from "@/lib/file-tab-id"
import { openExternalTab } from "@/lib/link-open"
import { openUrl } from "@/lib/platform"
import { cn, copyTextToClipboard } from "@/lib/utils"

import {
  BrowserAgentActivityControl,
  BrowserAgentShareControl,
} from "./browser-agent-access"
import { BrowserDeviceMenu } from "./browser-device-menu"
import { BrowserSendToChatControl } from "./browser-page-handoff"
import { ICON_BTN } from "./browser-toolbar-buttons"
import { BrowserTouchButton } from "./browser-touch-button"

/** How far the pointer may travel between press and release and still count
 *  as a click rather than a drag. The usual few pixels of hand tremor. */
const DRAG_SLOP_PX = 3

/**
 * The profile chip: which cookie jar this tab lives in, and a menu to open
 * the same page in another profile (a new tab beside this one — a tab's
 * profile is fixed, since its surface was built in it). Only shown once the
 * user has created a profile; with the default one alone there is nothing
 * to choose.
 */
function ProfileMenu({
  tab,
  currentUrl,
}: {
  tab: BrowserWorkspaceTab
  currentUrl: string
}) {
  const t = useTranslations("Browser.toolbar")
  const prefs = useBrowserPrefs()
  const openBrowserTab = useOptionalWorkspaceActions()?.openBrowserTab ?? null
  const profileId = tab.browser.profile
  if (prefs.profiles.length === 0 && profileId === DEFAULT_BROWSER_PROFILE_ID) {
    return null
  }
  const nameOf = (id: string) =>
    id === DEFAULT_BROWSER_PROFILE_ID
      ? t("profileDefault")
      : (prefs.profiles.find((profile) => profile.id === id)?.name ?? id)
  const name = nameOf(profileId)
  const ids = [
    DEFAULT_BROWSER_PROFILE_ID,
    ...prefs.profiles.map((profile) => profile.id),
  ]
  // A tab whose profile was deleted meanwhile still says where it lives.
  if (!ids.includes(profileId)) ids.push(profileId)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(ICON_BTN, "w-auto gap-1 px-1.5 text-xs")}
          title={t("profile", { name })}
          aria-label={t("profile", { name })}
        >
          <UserRound className="h-3.5 w-3.5 shrink-0" />
          <span className="max-w-24 truncate">{name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("profileMenuLabel")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={profileId}
          onValueChange={(id) => {
            if (id === profileId || !openBrowserTab) return
            openBrowserTab(currentUrl, { profile: id, openerTabId: tab.id })
          }}
        >
          {ids.map((id) => (
            <DropdownMenuRadioItem
              key={id}
              value={id}
              disabled={id !== profileId && !openBrowserTab}
            >
              <span className="truncate">{nameOf(id)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface WebToolbarControls {
  url: string
  externalUrl: string | null
  navigate: (url: string) => void
  reload?: () => void
  back?: () => void
  forward?: () => void
  inspect?: () => Promise<void>
  share?: (level: GrantLevel) => void
  capture?: (() => Promise<PageHandoff>) | null
  audio?: { on: boolean; toggle: () => void }
  keyboard?: { open: boolean; toggle: () => void }
}

export function BrowserToolbar({
  tab,
  state,
  web,
}: {
  tab: BrowserWorkspaceTab
  state: BrowserTabState | null
  web?: WebToolbarControls
}) {
  const t = useTranslations("Browser.toolbar")
  // Root translator alongside it, for the keys the BACKEND stamps on its
  // errors (`browser.inspector.error.*`); unknown keys fall back to the
  // English message the error already carries.
  const tRoot = useTranslations()
  const browserPrefs = useBrowserPrefs()
  const inspectorEnabled = browserPrefs.devtools
  const isWeb = Boolean(web)
  const openBrowserTab = useOptionalWorkspaceActions()?.openBrowserTab ?? null
  const backendId = browserTabBackendId(tab.id)
  const currentUrl =
    web?.url ?? (state?.url || state?.requestedUrl || tab.browser.initialUrl)
  const [egoImportSupported, setEgoImportSupported] = useState(false)
  const [egoImportOpen, setEgoImportOpen] = useState(false)
  useEffect(() => {
    if (isWeb) return
    let cancelled = false
    browserCapabilities().then((caps) => {
      if (!cancelled) {
        setEgoImportSupported(
          caps.available &&
            caps.platform === "windows" &&
            caps.surface === "child"
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [isWeb])
  const targetProfileName =
    tab.browser.profile === DEFAULT_BROWSER_PROFILE_ID
      ? t("profileDefault")
      : (browserPrefs.profiles.find(
          (profile) => profile.id === tab.browser.profile
        )?.name ?? tab.browser.profile)
  // The blank page is the absence of an address, so the bar shows its
  // placeholder rather than the literal `about:blank` — which nobody types,
  // and which would be selected-and-overtyped on every visit anyway. The
  // buttons that act on an address go quiet for the same reason.
  const blank = isBlankPageUrl(currentUrl)
  const address = blank ? "" : currentUrl
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // An empty tab is opened in order to type an address, so the caret starts
  // in the bar. Captured at mount: once the tab has a page, focus is the
  // page's — and a tab that was blank when it was switched to is still empty
  // when it comes back, so re-focusing on remount is the same answer.
  const [openedBlank] = useState(blank)
  useEffect(() => {
    if (openedBlank) inputRef.current?.focus()
  }, [openedBlank])

  // Focusing the bar hands over the whole address, so it can be overtyped in
  // one go — what every browser's address bar does, and the only reason to
  // click into this one (it is not a text box anyone edits a fragment of).
  //
  // `select()` from `onFocus` alone does not survive a click. The engine
  // focuses on mousedown — the selection appears, which is why it is visible
  // for as long as the button is held — and then runs its own selection
  // default on mouseup, collapsing everything to where the pointer landed.
  // That default runs AFTER the event reaches us, so re-selecting in the
  // handler is not enough either; the release has to be cancelled outright.
  //
  // Which is only right when the release ends a click. Drag out a range and
  // the engine's selection IS the answer, so nothing is cancelled and it
  // stands. How far the pointer travelled decides between the two, rather
  // than what the selection holds at release: that depends on when the engine
  // clobbers (some do it on the press instead), and so reads differently for
  // the same click from one engine to the next. The distance does not.
  const pressRef = useRef<{ x: number; y: number } | null>(null)

  const loading = web ? false : (state?.loading ?? true)
  const share = web?.share
  const capture = web?.capture
  const audio = web?.audio
  const egoImportReady =
    !!backendId &&
    state?.kind === "page" &&
    state.surface === "child" &&
    !loading &&
    !state.error &&
    /^https?:\/\//i.test(state.url)

  const submit = () => {
    if (!backendId && !web) return
    // Enter on an empty bar (a fresh tab) is not a mistake worth a toast.
    const text = draft ?? address
    if (!text.trim()) return
    const url = normalizeTypedAddress(text)
    if (!url) {
      toast.error(t("invalidUrl"))
      return
    }
    inputRef.current?.blur()
    setDraft(null)
    if (web) {
      web.navigate(url)
      return
    }
    if (!backendId) return
    // Seen from a window bound to a remote codeg-server, a loopback or
    // private address is that host's — and a tab of THIS computer reaches
    // this machine at the same address instead. It opens as a tab of the
    // remote host beside this one, the way a link to it does; with nowhere to
    // open one, it goes nowhere rather than here. A tab of the remote host
    // goes there itself: everything it loads comes from that host.
    if (tab.browser.remote !== true && isRemoteHostAddress(url)) {
      openBrowserTab?.(url, { remote: true, openerTabId: tab.id })
      return
    }
    const asOf = Date.now()
    void browserNavigate(backendId, url).then(
      // Asking for a page starts the record of what agents did to it again —
      // but only once the backend has taken the request. A tab whose surface
      // has gone refuses it, and then the document those lines are about is
      // still the one on screen. The grant is bound to the origin and is left
      // exactly as it was in either case.
      () => clearBrowserAgentActivity(tab.id, asOf),
      (error: unknown) => {
        toast.error(t("invalidUrl"), { description: String(error) })
      }
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      submit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      setDraft(null)
      inputRef.current?.blur()
    }
  }

  return (
    // This IS the file column's top row — a browser tab has no title header
    // above it (see `file-workspace-header.tsx`). So it takes that row's
    // shape: `h-10` and the same hairline, and NO fill of its own, so the
    // active tab's fill above flows into it and a workspace background image
    // shows through exactly as it does on a file tab's header.
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border/50 px-1.5">
      <button
        type="button"
        className={ICON_BTN}
        title={t("back")}
        aria-label={t("back")}
        disabled={web ? !web.back : !backendId || !state?.canGoBack}
        onClick={() => {
          if (web) web.back?.()
          else if (backendId) void browserGoBack(backendId)
        }}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={ICON_BTN}
        title={t("forward")}
        aria-label={t("forward")}
        disabled={web ? !web.forward : !backendId || !state?.canGoForward}
        onClick={() => {
          if (web) web.forward?.()
          else if (backendId) void browserGoForward(backendId)
        }}
      >
        <ArrowRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={ICON_BTN}
        title={loading ? t("stop") : t("reload")}
        aria-label={loading ? t("stop") : t("reload")}
        disabled={web ? !web.reload : !backendId}
        onClick={() => {
          if (web) {
            web.reload?.()
            return
          }
          if (!backendId) return
          if (loading) {
            // Stopping a load is not asking for the page again — the document
            // those lines are about is the one staying on screen — so it
            // clears nothing. Nor do back and forward (the two buttons above):
            // they are a move to another page, not a fresh look at this one.
            void browserStop(backendId)
            return
          }
          const asOf = Date.now()
          void browserReload(backendId).then(
            () => clearBrowserAgentActivity(tab.id, asOf),
            () => {
              // A reload the backend would not take leaves the page, and so
              // the record of what was done to it, as they were. Nothing is
              // said about it: this button has never had an error surface.
            }
          )
        }}
      >
        {loading ? <X className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
      </button>
      {/* The address field: a pill, with the page's own controls inside its
          two ends — who may touch the page on the left, what has touched it
          and where it can be sent on the right. Round on both ends rather
          than a rounded rectangle, so the controls sitting in it read as
          being in a field and not as a row of buttons with a box drawn round
          some of them. The focus ring is the wrapper's (`focus-within`): the
          input inside carries no chrome of its own. */}
      <div
        className={cn(
          // Inverted from the old placement: the row used to be a `bg-muted`
          // band with a `bg-background` field cut into it, but the row is now
          // the canvas itself, so the field is the tinted one. Translucent +
          // `backdrop-blur-sm` for the same reason the strip's buttons are —
          // over a workspace background image a flat tint reads as a muddy
          // patch, a blurred one as frosted glass.
          "mx-1 flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-full border border-border/60 bg-muted/50 px-0.5 backdrop-blur-sm",
          "focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/20"
        )}
      >
        {(!web || share) && (
          <BrowserAgentShareControl tab={tab} state={state} onShare={share} />
        )}
        <input
          ref={inputRef}
          value={draft ?? address}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            event.currentTarget.select()
          }}
          onMouseDown={(event) => {
            // Only a PRIMARY click that brings focus in selects everything.
            // Once the bar has focus a click means "put the caret here and
            // edit"; and a right or middle press is not a click at all —
            // cancelling its release would take the context menu with it on
            // the platforms that raise one from the release.
            pressRef.current =
              event.button === 0 &&
              document.activeElement !== event.currentTarget
                ? { x: event.clientX, y: event.clientY }
                : null
          }}
          onMouseUp={(event) => {
            const press = pressRef.current
            pressRef.current = null
            if (!press) return
            if (
              Math.abs(event.clientX - press.x) > DRAG_SLOP_PX ||
              Math.abs(event.clientY - press.y) > DRAG_SLOP_PX
            ) {
              return
            }
            event.preventDefault()
            event.currentTarget.select()
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={t("addressPlaceholder")}
          aria-label={t("addressPlaceholder")}
          title={web && !blank ? currentUrl : undefined}
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-xs text-foreground outline-none"
        />
        {!web && <BrowserAgentActivityControl tab={tab} />}
        {(!web || capture !== undefined) && (
          <BrowserSendToChatControl tab={tab} state={state} capture={capture} />
        )}
      </div>
      {/* Right of the field: it changes how the page in it is laid out, not
          which page it is, so it is the first thing after the address. */}
      <BrowserDeviceMenu tab={tab} />
      {web?.keyboard && (
        <BrowserTouchButton
          type="button"
          className={cn(ICON_BTN, "h-9 w-9 touch-manipulation")}
          title={t(web.keyboard.open ? "hideKeyboard" : "showKeyboard")}
          aria-label={t(web.keyboard.open ? "hideKeyboard" : "showKeyboard")}
          aria-pressed={web.keyboard.open}
          onClick={web.keyboard.toggle}
        >
          <Keyboard className="h-4 w-4" />
        </BrowserTouchButton>
      )}
      {/* A remote tab lives in its connection's profile, which is no
          choice of the person's and no place to open the page in another. */}
      {web || tab.browser.remote === true ? null : (
        <ProfileMenu tab={tab} currentUrl={currentUrl} />
      )}
      {/* This page's own actions, folded into one control. They act on the
          page rather than on the browsing — nobody reaches for them mid-scroll
          — so they cost a click here and give the row back to the address bar
          and to the controls that do belong in reach. Disabled whole on an
          empty tab: `about:blank` is no address to copy or hand to another
          browser, and no page to inspect either. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={ICON_BTN}
            title={t("more")}
            aria-label={t("more")}
            disabled={blank}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          <DropdownMenuItem
            onSelect={() => {
              // A remote tab's link as the remote host knows it: the macOS
              // alias its page uses means nothing anywhere else.
              const link =
                tab.browser.remote === true
                  ? remoteHostAddress(currentUrl)
                  : currentUrl
              void copyTextToClipboard(link).then(() =>
                toast.success(t("copied"))
              )
            }}
          >
            <Copy />
            {t("copyUrl")}
          </DropdownMenuItem>
          {/* The system browser is this computer's: a remote tab's address
              would reach this machine there, not the remote host. */}
          {web ? (
            <DropdownMenuItem
              disabled={!web.externalUrl}
              onSelect={() => {
                if (web.externalUrl) openExternalTab(web.externalUrl)
              }}
            >
              <ExternalLink />
              {t("openInSystem")}
            </DropdownMenuItem>
          ) : tab.browser.remote === true ? null : (
            <DropdownMenuItem onSelect={() => void openUrl(currentUrl)}>
              <ExternalLink />
              {t("openInSystem")}
            </DropdownMenuItem>
          )}
          {/* Hidden, not disabled, when the person switched the inspector
              off: they said they do not want it, and a greyed row saying so
              every time they open this menu is the wrong way to agree. */}
          {(inspectorEnabled || Boolean(web?.inspect)) &&
          (!web || web.inspect) ? (
            <DropdownMenuItem
              disabled={!backendId}
              onSelect={() => {
                const opening = web
                  ? web.inspect?.()
                  : backendId && browserOpenDevtools(backendId)
                if (!opening) return
                void opening.catch((error: unknown) => {
                  toast.error(t("inspectorFailed"), {
                    description: toLocalizedErrorMessage(
                      error,
                      tRoot as unknown as AppErrorTranslator
                    ),
                  })
                })
              }}
            >
              <Bug />
              {t("openInspector")}
            </DropdownMenuItem>
          ) : null}
          {audio && (
            <DropdownMenuItem onSelect={audio.toggle}>
              {audio.on ? <Volume2 /> : <VolumeX />}
              {t(audio.on ? "muteWebsite" : "unmuteWebsite")}
            </DropdownMenuItem>
          )}
          {web ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled>
                <KeyRound />
                <span>{t("importEgoLogin")}</span>
                <span className="ms-auto text-xs">
                  {t("egoImportDesktopOnly")}
                </span>
              </DropdownMenuItem>
            </>
          ) : egoImportSupported && tab.browser.remote !== true ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!egoImportReady}
                onSelect={() => setEgoImportOpen(true)}
              >
                <KeyRound />
                {t("importEgoLogin")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {egoImportSupported && tab.browser.remote !== true && egoImportOpen ? (
        <BrowserEgoImportDialog
          open={egoImportOpen}
          onOpenChange={setEgoImportOpen}
          tabId={backendId ?? ""}
          url={currentUrl}
          targetProfileName={targetProfileName}
          targetReady={egoImportReady}
        />
      ) : null}
      {loading ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
        >
          <div className="h-full w-1/3 animate-[browser-loading_1.2s_ease-in-out_infinite] bg-primary" />
        </div>
      ) : null}
    </div>
  )
}
