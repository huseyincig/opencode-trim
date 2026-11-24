/** @jsxImportSource @opentui/solid */
// Optional OpenCode V2 TUI sidebar: hidden until the server stats RPC answers; options.tui.enabled === false opts out.
// Read-only view of the server stats RPC; never touches server internals.
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { TRIM_STATS_RPC } from "./stats-rpc.ts"
import {
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
  type HealthState,
} from "./tui-model.ts"

const DEBOUNCE_MS = 150
const POLL_MS = 2000
const MAX_HIDDEN_RETRIES = 3
const COLLAPSED_BAR_WIDTH = 12
const EXPANDED_BAR_WIDTH = 24
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
        {props.value}
      </text>
    </box>
  )
}

function SegmentedBar(props: {
  segments: BarSegments
  health: HealthState
  sysColor: any
  chatColor: any
  toolsColor: any
  warnColor: any
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
      <Show when={s().toolsWarn > 0}>
        <text fg={props.warnColor} wrapMode="none">{"█".repeat(s().toolsWarn)}</text>
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
    const toggle = () => {
      try {
        void Promise.resolve(
          updateStored((draft: any) => {
            const next = nextViewMode(normalizeViewMode(draft))
            draft.mode = next
            draft.expanded = next === "expanded"
          }),
        ).catch(() => {})
      } catch {}
    }

    const theme = context.theme
    const base = () => theme?.text?.base ?? "white"
    const muted = () => theme?.text?.muted ?? base()
    const faint = () => theme?.text?.faint ?? "#3f434a"
    const sysColor = () => theme?.syntax?.keyword ?? theme?.text?.accent?.base ?? "#a875ff"
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
      const toolsBarColor = () => (model().health.state === "critical" ? errColor() : okColor())
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
                    <text fg={base()} wrapMode="none"><b>Trim</b></text>
                  </box>
                  <box flexDirection="row" alignItems="center" flexShrink={1} marginLeft={1}>
                    <SegmentedBar
                      segments={collapsedSegments()}
                      health={model().health.state}
                      sysColor={sysColor()}
                      chatColor={chatColor()}
                      toolsColor={toolsBarColor()}
                      warnColor={warnColor()}
                      emptyColor={faint()}
                    />
                  </box>
                  <box flexDirection="row" alignItems="center" flexShrink={0} marginLeft={1}>
                    <text fg={tone(model().health.tone)} wrapMode="none"><b>{model().context.percentText}</b></text>
                    <Show when={model().sessionAge}>
                      <text fg={muted()} wrapMode="none">{" " + model().sessionAge}</text>
                    </Show>
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
                justifyContent="space-between"
                alignItems="center"
                flexShrink={0}
                onMouseUp={toggle}
              >
                <box flexDirection="row" alignItems="center">
                  <text fg={muted()} wrapMode="none">{"▼ "}</text>
                  <text fg={base()} wrapMode="none"><b>Trim</b></text>
                </box>
                <box flexDirection="row" alignItems="center">
                  <text fg={muted()} wrapMode="none">{"v" + TRIM_VERSION}</text>
                  <Show when={header().marker}>
                    <text fg={tone("warning")} wrapMode="none">{" " + header().marker}</text>
                  </Show>
                </box>
              </box>
              <box width="100%" flexDirection="row" justifyContent="space-between" alignItems="center" flexShrink={0}>
                <SegmentedBar
                  segments={expandedSegments()}
                  health={model().health.state}
                  sysColor={sysColor()}
                  chatColor={chatColor()}
                  toolsColor={toolsBarColor()}
                  warnColor={warnColor()}
                  emptyColor={faint()}
                />
                <text fg={tone(model().health.tone)} flexShrink={0} marginLeft={1} wrapMode="none">
                  <b>{model().context.percentText}</b>
                </text>
              </box>
              <box width="100%" flexDirection="row" justifyContent="space-between" alignItems="center" flexShrink={0}>
                <box flexDirection="row" alignItems="center" flexShrink={0}>
                  <text fg={sysColor()} wrapMode="none">sys</text>
                  <text fg={chatColor()} wrapMode="none">{"  chat"}</text>
                  <text fg={okColor()} wrapMode="none">{"  tools"}</text>
                </box>
                <text fg={base()} flexShrink={1} marginLeft={1} wrapMode="none">
                  {model().context.pairText}
                </text>
              </box>
              <Show when={viewMode() === "default"}>
                <box width="100%" flexDirection="row" justifyContent="space-between" alignItems="center" flexShrink={0}>
                  <box flexDirection="row" alignItems="center" flexShrink={0}>
                    <text fg={tone(model().health.tone)} wrapMode="none">{"● " + model().health.label}</text>
                  </box>
                  <text fg={tone(model().statusRight.tone)} flexShrink={1} marginLeft={1} wrapMode="none">
                    {model().statusRight.parts.join(" · ")}
                  </text>
                </box>
              </Show>
              <Show when={viewMode() === "expanded"}>
                <For each={model().details}>
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
            </Show>
          </box>
        </Show>
      )
    }

    let disposeSlot: any
    try {
      disposeSlot = context.ui.slot({
        append: "sidebar.content",
        render: (input: any) => <TrimSidebar sessionID={input?.sessionID} />,
      })
    } catch {
      return () => {}
    }
    return () => {
      if (typeof disposeSlot === "function") disposeSlot()
    }
  },
})
