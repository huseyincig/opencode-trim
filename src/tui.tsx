/** @jsxImportSource @opentui/solid */
// Optional OpenCode V2 TUI sidebar: hidden until the server stats RPC answers; options.tui.enabled === false opts out.
// Read-only view of the server stats RPC; never touches server internals.
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { TRIM_STATS_RPC } from "./stats-rpc.ts"
import {
  buildGainReport,
  buildHeader,
  buildSidebarModel,
  compactionBreakdown,
  compactionHistory,
  isStale,
  messageBreakdown,
  nativeContextTokens,
  nextViewMode,
  normalizeEventSessionID,
  normalizeViewMode,
  STORAGE_KEY,
  TRIM_VERSION,
  type BarSegments,
  type TrimViewMode,
} from "./tui-model.ts"

const DEBOUNCE_MS = 150
const POLL_MS = 2000
const MAX_HIDDEN_RETRIES = 3
const COLLAPSED_BAR_WIDTH = 14
const EXPANDED_BAR_WIDTH = 34
const REFRESH_EVENTS = ["session.compaction.started", "session.compaction.ended", "session.compaction.failed", "session.step.ended"]
const RELOAD_EVENTS = ["plugin.updated", "model.updated", "provider.updated"]

function normDir(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined
  const s = v.replace(/[\\/]+$/, "")
  return s || "/"
}

function isRpcUnavailable(err: unknown): boolean {
  const msg = String((err as any)?.message ?? (err as any)?.code ?? err ?? "").toLowerCase()
  return msg.includes("rpc.unavailable") || msg.includes("unavailable") || msg.includes("404") || msg.includes("not found")
}

function StatRow(props: {
  label: string
  value: string | number
  labelColor: any
  valueColor: any
}) {
  return (
    <box width="100%" flexDirection="row" justifyContent="space-between">
      <text fg={props.labelColor} flexShrink={0} wrapMode="none">
        {props.label}
      </text>
      <text fg={props.valueColor} flexShrink={1} marginLeft={1} wrapMode="none">
        <b>{props.value}</b>
      </text>
    </box>
  )
}

function SegmentedBar(props: {
  segments: BarSegments
  sysColor: any
  chatColor: any
  toolsColor: any
  emptyColor: any
}) {
  const s = () => props.segments
  return (
    <box flexDirection="row" flexShrink={1}>
      <Show when={s().sys > 0}>
        <text fg={props.sysColor} wrapMode="none">{"█".repeat(s().sys)}</text>
      </Show>
      <Show when={s().chat > 0}>
        <text fg={props.chatColor} wrapMode="none">{"█".repeat(s().chat)}</text>
      </Show>
      <Show when={s().tools > 0}>
        <text fg={props.toolsColor} wrapMode="none">{"█".repeat(s().tools)}</text>
      </Show>
      <Show when={s().empty > 0}>
        <text fg={props.emptyColor} wrapMode="none">{"█".repeat(s().empty)}</text>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-trim.tui",
  setup(context: any) {
    // Auto-discovered TUI plugins receive no options, so the server's tui.enabled is the single
    // opt-in: stay hidden until the server stats RPC answers. Explicit false is a hard opt-out.
    if (context.options?.tui?.enabled === false) return

    let stored: any
    let updateStored: any
    let rpc: any
    try {
      ;[stored, updateStored] = context.storage.store(STORAGE_KEY, { initial: { mode: "default" } })
      rpc = context.client.rpc(TRIM_STATS_RPC)
    } catch {
      return () => {}
    }
    if (!stored || typeof updateStored !== "function" || !rpc) return () => {}

    const localDir = (): string | undefined => normDir(context.location?.directory)
    const foreign = (event: any): boolean => {
      const mine = localDir()
      if (!mine) return false
      for (const holder of [event, event?.data, event?.properties]) {
        const raw = holder?.location?.directory
        if (raw === undefined || raw === null) continue
        const dir = normDir(raw)
        if (!dir || dir !== mine) return true
      }
      return false
    }

    const viewMode = () => normalizeViewMode(stored)
    const setViewMode = (mode: TrimViewMode) => {
      try {
        void Promise.resolve(
          updateStored((draft: any) => {
            draft.mode = mode
            draft.expanded = mode === "expanded"
          }),
        ).catch(() => {})
      } catch {}
    }
    const toggle = () => setViewMode(nextViewMode(viewMode()))
    let activeSessionID: string | undefined
    let latestState: {
      snapshot: any
      nativeTokens: number | null
      nativeLimit: number | null
      sessionCreatedAt: number | null
      history: any
      compDetails: any
      msgBreakdown: any
    } = {
      snapshot: null,
      nativeTokens: null,
      nativeLimit: null,
      sessionCreatedAt: null,
      history: null,
      compDetails: null,
      msgBreakdown: null,
    }

    const theme = context.theme
    const base = () => theme?.text?.base ?? "white"
    const muted = () => theme?.text?.muted ?? base()
    const bgColor = () => theme?.background?.base ?? theme?.background?.panel ?? "#111318"
    const badgeColor = () => theme?.text?.base ?? "#e2e8f0"
    const faint = () => theme?.text?.faint ?? "#3f434a"
    const sysColor = () => theme?.syntax?.keyword ?? theme?.brand?.primary?.base ?? theme?.text?.accent?.base ?? "#a875ff"
    const chatColor = () => theme?.syntax?.function ?? theme?.status?.info?.base ?? "#38bdf8"
    const okColor = () => theme?.status?.success?.base ?? "#4ade80"
    const warnColor = () => theme?.status?.warning?.base ?? "#facc15"
    const errColor = () => theme?.status?.error?.base ?? "#f87171"
    const tone = (name: string) =>
      name === "error" ? theme?.status?.error?.base ?? theme?.text?.feedback?.error?.base ?? errColor()
      : name === "warning" ? theme?.status?.warning?.base ?? theme?.text?.feedback?.warning?.base ?? warnColor()
      : name === "success" ? theme?.status?.success?.base ?? okColor()
      : name === "muted" ? muted()
      : name === "accent" ? theme?.text?.accent?.base ?? theme?.text?.accent ?? okColor()
      : base()

    function TrimSidebar(props: { sessionID?: string }) {
      // Hidden until the first successful stats RPC snapshot (the server's tui.enabled is the opt-in).
      // Kept across session switches so the sidebar never unmounts/flickers when changing sessions.
      const [visible, setVisible] = createSignal(false)
      const [snapshot, setSnapshot] = createSignal<any>(null)
      const [failed, setFailed] = createSignal(false)
      const [nativeTokens, setNativeTokens] = createSignal<number | null>(null)
      const [nativeLimit, setNativeLimit] = createSignal<number | null>(null)
      const [sessionCreatedAt, setSessionCreatedAt] = createSignal<number | null>(null)
      const [history, setHistory] = createSignal<any>(null)
      const [compDetails, setCompDetails] = createSignal<any>(null)
      const [msgBreakdown, setMsgBreakdown] = createSignal<any>(null)
      const [now, setNow] = createSignal(Date.now())
      const running = () => !!props.sessionID && context.data?.session?.status?.(props.sessionID) === "running"

      createEffect(
        on(
          () => props.sessionID,
          (sessionID) => {
            activeSessionID = sessionID
            setSnapshot(null)
            setFailed(false)
            setNativeTokens(null)
            setNativeLimit(null)
            setSessionCreatedAt(null)
            setHistory(null)
            setCompDetails(null)
            setMsgBreakdown(null)
            if (!sessionID) return
            let seq = 0
            let disposed = false
            let timer: ReturnType<typeof setTimeout> | undefined
            let messagesSynced = false
            let modelsSynced = false
            let hiddenRetries = 0
            let hiddenStopped = false

            const resolveSessionMeta = async (id: string): Promise<{ limit: number | null; createdAt: number | null }> => {
              const session = await Promise.resolve(context.data?.session?.get?.(id))
              const rawCreated = session?.time?.created
              const createdAt = typeof rawCreated === "number" && Number.isFinite(rawCreated) && rawCreated > 0 ? rawCreated : null
              const ref = session?.model
              if (!ref) return { limit: null, createdAt }
              const models = context.data?.location?.model
              if (!models || typeof models.list !== "function") return { limit: null, createdAt }
              const find = (list: any) =>
                Array.isArray(list)
                  ? list.find((m: any) => m?.providerID === ref.providerID && (m?.id === ref.id || m?.modelID === ref.id))
                  : undefined
              let found = find(await Promise.resolve(models.list(context.location)))
              if (!found && !modelsSynced && typeof models.sync === "function") {
                modelsSynced = true
                await Promise.resolve(models.sync(context.location))
                found = find(await Promise.resolve(models.list(context.location)))
              }
              const v = found?.limit?.context
              const limit = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null
              return { limit, createdAt }
            }

            const fetchNow = async () => {
              if (disposed) return
              const mine = ++seq
              // Probe RPC first: when server tui.enabled is false, avoid unnecessary message/model sync calls.
              let next: any
              try {
                next = await rpc.snapshot({ sessionID }, context.location ? { location: context.location } : undefined)
                if (disposed || mine !== seq) return
                setSnapshot(next ?? null)
                latestState.snapshot = next ?? null
                setFailed(next == null)
                if (next != null) {
                  setVisible(true)
                  hiddenRetries = 0
                  hiddenStopped = false
                } else if (!visible()) {
                  hiddenRetries += 1
                  if (hiddenRetries >= MAX_HIDDEN_RETRIES) hiddenStopped = true
                  return
                }
                setNow(Date.now())
              } catch (err) {
                if (disposed || mine !== seq) return
                setFailed(true)
                setNow(Date.now())
                if (!visible()) {
                  hiddenRetries += 1
                  if (isRpcUnavailable(err) || hiddenRetries >= MAX_HIDDEN_RETRIES) hiddenStopped = true
                  return
                }
              }

              if (!visible()) return

              try {
                const messages = context.data?.session?.message
                if (messages && typeof messages.list === "function") {
                  let list = await Promise.resolve(messages.list(sessionID))
                  let tokens = nativeContextTokens(list)
                  if (tokens === null && !messagesSynced && typeof messages.sync === "function") {
                    // The TUI message cache is empty until synced; sync at most once per session mount.
                    messagesSynced = true
                    try { await Promise.resolve(messages.sync(sessionID)) } catch {}
                    list = await Promise.resolve(messages.list(sessionID))
                    tokens = nativeContextTokens(list)
                  }
                  if (!disposed && mine === seq) {
                    setNativeTokens(tokens)
                    setHistory(compactionHistory(list))
                    setCompDetails(compactionBreakdown(list))
                    setMsgBreakdown(messageBreakdown(list))
                    latestState.nativeTokens = tokens
                    latestState.history = compactionHistory(list)
                    latestState.compDetails = compactionBreakdown(list)
                    latestState.msgBreakdown = messageBreakdown(list)
                  }
                }
              } catch {
                if (!disposed && mine === seq) {
                  setNativeTokens(null)
                  setHistory(null)
                  setCompDetails(null)
                  setMsgBreakdown(null)
                }
              }

              try {
                const meta = await resolveSessionMeta(sessionID)
                if (!disposed && mine === seq) {
                  setNativeLimit(meta.limit)
                  setSessionCreatedAt(meta.createdAt)
                  latestState.nativeLimit = meta.limit
                  latestState.sessionCreatedAt = meta.createdAt
                }
              } catch {
                if (!disposed && mine === seq) {
                  setNativeLimit(null)
                  setSessionCreatedAt(null)
                }
              }
            }

            const schedule = () => {
              if (disposed) return
              if (timer) clearTimeout(timer)
              timer = setTimeout(fetchNow, DEBOUNCE_MS)
            }

            const unsubs: Array<() => void> = []
            try {
              const off = rpc.events?.on?.("changed", (event: any) => {
                if (foreign(event)) return
                if (normalizeEventSessionID(event) === sessionID) schedule()
              })
              if (typeof off === "function") unsubs.push(off)
            } catch {}
            for (const type of REFRESH_EVENTS) {
              try {
                const off = context.data?.on?.(type, (event: any) => {
                  if (foreign(event)) return
                  if (normalizeEventSessionID(event) !== sessionID) return
                  schedule()
                })
                if (typeof off === "function") unsubs.push(off)
              } catch {}
            }
            for (const type of RELOAD_EVENTS) {
              try {
                const off = context.data?.on?.(type, (event: any) => {
                  if (foreign(event)) return
                  hiddenStopped = false
                  hiddenRetries = 0
                  modelsSynced = false
                  schedule()
                })
                if (typeof off === "function") unsubs.push(off)
              } catch {}
            }

            void fetchNow()
            // Single unified interval: refreshes running sessions, ages relative timestamps, and stops retrying when RPC is off.
            const watcher = setInterval(() => {
              if (disposed) return
              setNow(Date.now())
              if (visible()) {
                if (running()) void fetchNow()
              } else if (!hiddenStopped) {
                void fetchNow()
              }
            }, POLL_MS)
            ;(watcher as { unref?: () => void }).unref?.()

            onCleanup(() => {
              disposed = true
              seq++
              if (timer) clearTimeout(timer)
              clearInterval(watcher)
              for (const off of unsubs) {
                try { off() } catch {}
              }
            })
          },
        ),
      )

      const stale = createMemo(() => failed() || isStale(snapshot(), now(), running()))
      const header = createMemo(() =>
        buildHeader(snapshot(), {
          expanded: viewMode() !== "collapsed",
          stale: stale(),
          nativeTokens: nativeTokens(),
          nativeLimitTokens: nativeLimit(),
        }),
      )
      const model = createMemo(() =>
        buildSidebarModel(snapshot(), now(), {
          nativeTokens: nativeTokens(),
          nativeLimitTokens: nativeLimit(),
          sessionCreatedAt: sessionCreatedAt(),
          compactionHistory: history(),
          compactionBreakdown: compDetails(),
          messageBreakdown: msgBreakdown(),
        }),
      )
      const collapsedSegments = createMemo(() => model().segments(COLLAPSED_BAR_WIDTH))
      const expandedSegments = createMemo(() => model().segments(EXPANDED_BAR_WIDTH))

      return (
        <Show when={visible()}>
          <box flexDirection="column" flexShrink={0} width="100%" gap={0}>
            <Show
              when={viewMode() !== "collapsed"}
              fallback={
                <box
                  width="100%"
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                  flexShrink={0}
                  onMouseUp={toggle}
                >
                  <box flexDirection="row" alignItems="center" flexShrink={0}>
                    <text fg={muted()} wrapMode="none">{"▶ "}</text>
                    <box backgroundColor={badgeColor()} paddingLeft={1} paddingRight={1}>
                      <text fg={bgColor()} wrapMode="none">trim</text>
                    </box>
                  </box>
                  <box flexGrow={1} flexDirection="row" justifyContent="center" alignItems="center" marginLeft={1} marginRight={1}>
                    <SegmentedBar
                      segments={collapsedSegments()}
                      sysColor={sysColor()}
                      chatColor={chatColor()}
                      toolsColor={okColor()}
                      emptyColor={faint()}
                    />
                  </box>
                  <box flexDirection="row" alignItems="center" flexShrink={0}>
                    <text fg={tone(model().health.tone)} wrapMode="none"><b>{model().context.percentText}</b></text>
                    <Show when={header().marker}>
                      <text fg={tone("warning")} wrapMode="none">{" " + header().marker}</text>
                    </Show>
                  </box>
                </box>
              }
            >
              <box
                width="100%"
                flexDirection="row"
                alignItems="center"
                flexShrink={0}
                onMouseUp={toggle}
              >
                <text fg={muted()} wrapMode="none">{"▼ "}</text>
                <box backgroundColor={badgeColor()} paddingLeft={1} paddingRight={1}>
                  <text fg={bgColor()} wrapMode="none">trim</text>
                </box>
                <text fg={muted()} wrapMode="none">{" v" + TRIM_VERSION}</text>
                <text fg={tone(model().health.tone)} flexShrink={1} wrapMode="none">
                  {" · ● " + model().health.label}
                </text>
                <Show when={header().marker}>
                  <text fg={tone("warning")} flexShrink={0} wrapMode="none">{" " + header().marker}</text>
                </Show>
              </box>
              <box width="100%" flexDirection="column" paddingLeft={1} paddingRight={1} gap={0}>
                <box width="100%" flexDirection="row" justifyContent="center" alignItems="center" flexShrink={0} marginTop={1}>
                  <SegmentedBar
                    segments={expandedSegments()}
                    sysColor={sysColor()}
                    chatColor={chatColor()}
                    toolsColor={okColor()}
                    emptyColor={faint()}
                  />
                </box>
                <box width="100%" flexDirection="row" justifyContent="space-between" alignItems="center" flexShrink={0}>
                  <box flexDirection="row" alignItems="center" flexShrink={0}>
                    <text fg={sysColor()} wrapMode="none">sys </text>
                    <text fg={base()} wrapMode="none"><b>{model().composition.sysText}</b></text>
                  </box>
                  <box flexDirection="row" alignItems="center" flexShrink={0}>
                    <text fg={chatColor()} wrapMode="none">chat </text>
                    <text fg={base()} wrapMode="none"><b>{model().composition.chatText}</b></text>
                  </box>
                  <box flexDirection="row" alignItems="center" flexShrink={0}>
                    <text fg={okColor()} wrapMode="none">tools </text>
                    <text fg={base()} wrapMode="none"><b>{model().composition.toolsText}</b></text>
                  </box>
                </box>
                <Show when={viewMode() === "default"}>
                  <For each={model().normalRows}>
                    {(row) => (
                      <StatRow
                        label={row.label}
                        value={row.parts.join(" · ")}
                        labelColor={muted()}
                        valueColor={tone(row.tone)}
                      />
                    )}
                  </For>
                </Show>
                <Show when={viewMode() === "expanded"}>
                  <For each={model().detailRows}>
                    {(row) => (
                      <StatRow
                        label={row.label}
                        value={row.parts.join(" · ")}
                        labelColor={muted()}
                        valueColor={tone(row.tone)}
                      />
                    )}
                  </For>
                </Show>
                <Show when={stale()}>
                  <text fg={theme?.text?.faint ?? muted()} flexShrink={1} wrapMode="none">
                    {failed() ? "stats unavailable" : "stats stale"}
                  </text>
                </Show>
              </box>
            </Show>
          </box>
        </Show>
      )
    }

    const runTrimCommand = async (rawArg?: unknown) => {
      const arg = typeof rawArg === "string" ? rawArg.trim().toLowerCase() : ""
      if (arg === "minimal" || arg === "collapsed") {
        setViewMode("collapsed")
        context.ui?.toast?.show?.({ title: "Trim", message: "Sidebar set to minimal" })
        return
      }
      if (arg === "normal" || arg === "default") {
        setViewMode("default")
        context.ui?.toast?.show?.({ title: "Trim", message: "Sidebar set to normal" })
        return
      }
      if (arg === "detail" || arg === "expanded") {
        setViewMode("expanded")
        context.ui?.toast?.show?.({ title: "Trim", message: "Sidebar set to detail" })
        return
      }
      if (arg === "toggle") {
        const next = nextViewMode(viewMode())
        setViewMode(next)
        context.ui?.toast?.show?.({ title: "Trim", message: "Sidebar set to " + next })
        return
      }
      let snap = latestState.snapshot
      if (activeSessionID) {
        try {
          const fresh = await rpc.snapshot({ sessionID: activeSessionID }, context.location ? { location: context.location } : undefined)
          if (fresh) snap = fresh
        } catch {}
      }
      const report = buildGainReport(snap, Date.now(), {
        nativeTokens: latestState.nativeTokens,
        nativeLimitTokens: latestState.nativeLimit,
        sessionCreatedAt: latestState.sessionCreatedAt,
        compactionHistory: latestState.history,
        compactionBreakdown: latestState.compDetails,
        messageBreakdown: latestState.msgBreakdown,
      })
      if (typeof context.ui?.dialog?.alert === "function") {
        await context.ui.dialog.alert({ title: "Trim v" + TRIM_VERSION, message: report })
      } else {
        context.ui?.toast?.show?.({ title: "Trim v" + TRIM_VERSION, message: report })
      }
    }

    let disposeSlot: any
    let disposeKeymap: any
    try {
      disposeSlot = context.ui.slot({
        append: "sidebar.content",
        render: (input: any) => <TrimSidebar sessionID={input?.sessionID} />,
      })
    } catch {
      return () => {}
    }
    try {
      if (typeof context.keymap?.layer === "function") {
        disposeKeymap = context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "opencode-trim.status",
              title: "Trim status and savings",
              group: "Trim",
              palette: true,
              slash: { name: "trim", aliases: ["trim-gain"], arguments: true },
              enabled: () => true,
              run: runTrimCommand,
            },
          ],
          bindings: [],
        }))
      }
    } catch {
      disposeKeymap = undefined
    }
    return () => {
      if (typeof disposeKeymap === "function") disposeKeymap()
      else if (disposeKeymap && typeof disposeKeymap.dispose === "function") disposeKeymap.dispose()
      if (typeof disposeSlot === "function") disposeSlot()
    }
  },
})
