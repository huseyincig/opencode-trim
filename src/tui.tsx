/** @jsxImportSource @opentui/solid */
// Optional OpenCode V2 TUI sidebar: hidden until the server stats RPC answers; options.tui.enabled === false opts out.
// Read-only view of the server stats RPC; never touches server internals.
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { TRIM_STATS_RPC } from "./stats-rpc.ts"
import {
  buildCollapsedRows,
  buildHeader,
  buildSections,
  compactionHistory,
  isStale,
  nativeContextTokens,
  normalizeEventSessionID,
  STORAGE_KEY,
  TRIM_VERSION,
} from "./tui-model.ts"

const DEBOUNCE_MS = 150
const POLL_MS = 2000
const MAX_HIDDEN_RETRIES = 3
const REFRESH_EVENTS = ["session.compaction.started", "session.compaction.ended", "session.compaction.failed", "session.step.ended"]

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
      ;[stored, updateStored] = context.storage.store(STORAGE_KEY, { initial: { expanded: false } })
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

    const isExpanded = () => stored?.expanded === true
    const toggle = () => {
      try {
        void Promise.resolve(updateStored((draft: any) => { draft.expanded = !draft.expanded })).catch(() => {})
      } catch {}
    }

    const theme = context.theme
    const base = () => theme?.text?.base ?? "white"
    const muted = () => theme?.text?.muted ?? base()
    const tone = (name: string) =>
      name === "error" ? theme?.status?.error?.base ?? theme?.text?.feedback?.error?.base ?? base()
      : name === "warning" ? theme?.status?.warning?.base ?? theme?.text?.feedback?.warning?.base ?? base()
      : name === "success" ? theme?.status?.success?.base ?? theme?.text?.accent?.base ?? base()
      : name === "muted" ? muted()
      : name === "accent" ? theme?.text?.accent?.base ?? theme?.text?.accent ?? theme?.status?.success?.base ?? base()
      : base()

    function TrimSidebar(props: { sessionID?: string }) {
      // Hidden until the first successful stats RPC snapshot (the server's tui.enabled is the opt-in).
      // Kept across session switches so the sidebar never unmounts/flickers when changing sessions.
      const [visible, setVisible] = createSignal(false)
      const [snapshot, setSnapshot] = createSignal<any>(null)
      const [failed, setFailed] = createSignal(false)
      const [nativeTokens, setNativeTokens] = createSignal<number | null>(null)
      const [nativeLimit, setNativeLimit] = createSignal<number | null>(null)
      const [history, setHistory] = createSignal<any>(null)
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
            setHistory(null)
            if (!sessionID) return
            let seq = 0
            let disposed = false
            let timer: ReturnType<typeof setTimeout> | undefined
            let messagesSynced = false
            let modelsSynced = false
            let hiddenRetries = 0
            let hiddenStopped = false

            const resolveLimit = async (id: string): Promise<number | null> => {
              const session = await Promise.resolve(context.data?.session?.get?.(id))
              const ref = session?.model
              if (!ref) return null
              const models = context.data?.location?.model
              if (!models || typeof models.list !== "function") return null
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
              return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null
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
                  }
                }
              } catch {
                if (!disposed && mine === seq) {
                  setNativeTokens(null)
                  setHistory(null)
                }
              }

              try {
                const limit = await resolveLimit(sessionID)
                if (!disposed && mine === seq) setNativeLimit(limit)
              } catch {
                if (!disposed && mine === seq) setNativeLimit(null)
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
      const collapsedRows = createMemo(() => buildCollapsedRows(snapshot(), { nativeTokens: nativeTokens(), nativeLimitTokens: nativeLimit() }))
      const sections = createMemo(() => buildSections(snapshot(), now(), { nativeTokens: nativeTokens(), nativeLimitTokens: nativeLimit(), compactionHistory: history() }))
      const header = createMemo(() => buildHeader(snapshot(), { expanded: isExpanded(), stale: stale(), nativeTokens: nativeTokens(), nativeLimitTokens: nativeLimit() }))

      return (
        <Show when={visible()}>
          <box flexDirection="column" flexShrink={0} width="100%" gap={0}>
            <box
              width="100%"
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              flexShrink={0}
              onMouseUp={toggle}
            >
              <box flexDirection="row" alignItems="center">
                <text fg={muted()} wrapMode="none">{isExpanded() ? "▼ " : "▶ "}</text>
                <text fg={base()} wrapMode="none"><b>Trim</b></text>
              </box>
              <box flexDirection="row" alignItems="center">
                <text fg={muted()} wrapMode="none">{"v" + TRIM_VERSION}</text>
                <Show when={header().marker}>
                  <text fg={tone("warning")} wrapMode="none">{" " + header().marker}</text>
                </Show>
              </box>
            </box>
            <Show when={!isExpanded()}>
              <For each={collapsedRows()}>
                {(row) => (
                  <StatRow
                    label={row.label}
                    value={row.value}
                    labelColor={muted()}
                    valueColor={tone(row.tone)}
                  />
                )}
              </For>
            </Show>
            <Show when={isExpanded()}>
              <For each={sections()}>
                {(section) => (
                  <box flexDirection="column" flexShrink={0} width="100%">
                    {section.title ? (
                      <text fg={muted()} attributes={1} flexShrink={1} wrapMode="none">
                        {section.title}
                      </text>
                    ) : null}
                    <For each={section.rows}>
                      {(row) => (
                        <StatRow
                          label={row.label}
                          value={row.value}
                          labelColor={muted()}
                          valueColor={tone(row.tone)}
                        />
                      )}
                    </For>
                  </box>
                )}
              </For>
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
