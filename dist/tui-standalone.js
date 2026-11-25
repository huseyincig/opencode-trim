import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
// Optional OpenCode V2 TUI sidebar: hidden until the server stats RPC answers; options.tui.enabled === false opts out.
// Read-only view of the server stats RPC; never touches server internals.
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { TRIM_STATS_RPC } from "./stats-rpc.js";
import { buildGainReport, buildHeader, buildSidebarModel, compactionBreakdown, compactionHistory, isStale, messageBreakdown, nativeContextTokens, nextViewMode, normalizeEventSessionID, normalizeViewMode, STORAGE_KEY, TRIM_VERSION } from "./tui-model.js";
const DEBOUNCE_MS = 150;
const POLL_MS = 2000;
const IDLE_TICK_MS = 30_000;
const MAX_HIDDEN_RETRIES = 3;
const COLLAPSED_BAR_WIDTH = 14;
const EXPANDED_BAR_WIDTH = 34;
const REFRESH_EVENTS = ["session.compaction.started", "session.compaction.ended", "session.compaction.failed", "session.step.ended", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"];
const RELOAD_EVENTS = ["plugin.updated", "model.updated", "provider.updated"];
function messageListKey(list) {
  if (!Array.isArray(list)) return "none";
  const len = list.length;
  if (len === 0) return "0";
  const last = list[len - 1];
  const id = typeof last?.id === "string" ? last.id : "";
  const status = typeof last?.status === "string" ? last.status : "";
  const inp = typeof last?.tokens?.input === "number" ? last.tokens.input : -1;
  const cr = typeof last?.tokens?.cache?.read === "number" ? last.tokens.cache.read : -1;
  const parts = Array.isArray(last?.parts) ? last.parts.length : Array.isArray(last?.content) ? last.content.length : -1;
  return `${len}:${id}:${status}:${inp}:${cr}:${parts}`;
}
function normDir(v) {
  if (typeof v !== "string" || !v) return undefined;
  const s = v.replace(/[\\/]+$/, "");
  return s || "/";
}
function isRpcUnavailable(err) {
  const msg = String(err?.message ?? err?.code ?? err ?? "").toLowerCase();
  return msg.includes("rpc.unavailable") || msg.includes("unavailable") || msg.includes("404") || msg.includes("not found");
}
function StatRow(props) {
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text"),
      _el$3 = _$createElement("text"),
      _el$4 = _$createElement("b");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "justifyContent", "space-between");
    _$setProp(_el$2, "flexShrink", 0);
    _$setProp(_el$2, "wrapMode", "none");
    _$insert(_el$2, () => props.label);
    _$insertNode(_el$3, _el$4);
    _$setProp(_el$3, "flexShrink", 1);
    _$setProp(_el$3, "marginLeft", 1);
    _$setProp(_el$3, "wrapMode", "none");
    _$insert(_el$4, () => props.value);
    _$effect(_p$ => {
      var _v$ = props.labelColor,
        _v$2 = props.valueColor;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
}
function SegmentedBar(props) {
  const s = () => props.segments;
  return (() => {
    var _el$5 = _$createElement("box");
    _$setProp(_el$5, "flexDirection", "row");
    _$setProp(_el$5, "flexShrink", 1);
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return s().sys > 0;
      },
      get children() {
        var _el$6 = _$createElement("text");
        _$setProp(_el$6, "wrapMode", "none");
        _$insert(_el$6, () => "█".repeat(s().sys));
        _$effect(_$p => _$setProp(_el$6, "fg", props.sysColor, _$p));
        return _el$6;
      }
    }), null);
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return s().chat > 0;
      },
      get children() {
        var _el$7 = _$createElement("text");
        _$setProp(_el$7, "wrapMode", "none");
        _$insert(_el$7, () => "█".repeat(s().chat));
        _$effect(_$p => _$setProp(_el$7, "fg", props.chatColor, _$p));
        return _el$7;
      }
    }), null);
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return s().tools > 0;
      },
      get children() {
        var _el$8 = _$createElement("text");
        _$setProp(_el$8, "wrapMode", "none");
        _$insert(_el$8, () => "█".repeat(s().tools));
        _$effect(_$p => _$setProp(_el$8, "fg", props.toolsColor, _$p));
        return _el$8;
      }
    }), null);
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return s().empty > 0;
      },
      get children() {
        var _el$9 = _$createElement("text");
        _$setProp(_el$9, "wrapMode", "none");
        _$insert(_el$9, () => "█".repeat(s().empty));
        _$effect(_$p => _$setProp(_el$9, "fg", props.emptyColor, _$p));
        return _el$9;
      }
    }), null);
    return _el$5;
  })();
}
export default Plugin.define({
  id: "opencode-trim.tui",
  setup(context) {
    // Auto-discovered TUI plugins receive no options, so the server's tui.enabled is the single
    // opt-in: stay hidden until the server stats RPC answers. Explicit false is a hard opt-out.
    if (context.options?.tui?.enabled === false) return;
    let stored;
    let updateStored;
    let rpc;
    try {
      ;
      [stored, updateStored] = context.storage.store(STORAGE_KEY, {
        initial: {
          mode: "default"
        }
      });
      rpc = context.client.rpc(TRIM_STATS_RPC);
    } catch {
      return () => {};
    }
    if (!stored || typeof updateStored !== "function" || !rpc) return () => {};
    const localDir = () => normDir(context.location?.directory);
    const foreign = event => {
      const mine = localDir();
      if (!mine) return false;
      for (const holder of [event, event?.data, event?.properties]) {
        const raw = holder?.location?.directory;
        if (raw === undefined || raw === null) continue;
        const dir = normDir(raw);
        if (!dir || dir !== mine) return true;
      }
      return false;
    };
    const viewMode = () => normalizeViewMode(stored);
    const setViewMode = mode => {
      try {
        void Promise.resolve(updateStored(draft => {
          draft.mode = mode;
          draft.expanded = mode === "expanded";
        })).catch(() => {});
      } catch {}
    };
    const toggle = () => setViewMode(nextViewMode(viewMode()));
    let activeSessionID;
    let sessionGen = 0;
    let latestState = {
      snapshot: null,
      nativeTokens: null,
      nativeLimit: null,
      sessionCreatedAt: null,
      history: null,
      compDetails: null,
      msgBreakdown: null
    };
    const theme = context.theme;
    const base = () => theme?.text?.base ?? "white";
    const muted = () => theme?.text?.muted ?? base();
    const bgColor = () => theme?.background?.base ?? theme?.background?.panel ?? "#111318";
    const badgeColor = () => theme?.text?.base ?? "#e2e8f0";
    const faint = () => theme?.text?.faint ?? "#3f434a";
    const sysColor = () => theme?.syntax?.keyword ?? theme?.brand?.primary?.base ?? theme?.text?.accent?.base ?? "#a875ff";
    const chatColor = () => theme?.syntax?.function ?? theme?.status?.info?.base ?? "#38bdf8";
    const okColor = () => theme?.status?.success?.base ?? "#4ade80";
    const warnColor = () => theme?.status?.warning?.base ?? "#facc15";
    const errColor = () => theme?.status?.error?.base ?? "#f87171";
    const tone = name => name === "error" ? theme?.status?.error?.base ?? theme?.text?.feedback?.error?.base ?? errColor() : name === "warning" ? theme?.status?.warning?.base ?? theme?.text?.feedback?.warning?.base ?? warnColor() : name === "success" ? theme?.status?.success?.base ?? okColor() : name === "muted" ? muted() : name === "accent" ? theme?.text?.accent?.base ?? theme?.text?.accent ?? okColor() : base();
    function TrimSidebar(props) {
      // Hidden until the first successful stats RPC snapshot (the server's tui.enabled is the opt-in).
      // Kept across session switches so the sidebar never unmounts/flickers when changing sessions.
      const [visible, setVisible] = createSignal(false);
      const [snapshot, setSnapshot] = createSignal(null);
      const [failed, setFailed] = createSignal(false);
      const [nativeTokens, setNativeTokens] = createSignal(null);
      const [nativeLimit, setNativeLimit] = createSignal(null);
      const [sessionCreatedAt, setSessionCreatedAt] = createSignal(null);
      const [history, setHistory] = createSignal(null);
      const [compDetails, setCompDetails] = createSignal(null);
      const [msgBreakdown, setMsgBreakdown] = createSignal(null);
      const [now, setNow] = createSignal(Date.now());
      const running = () => !!props.sessionID && context.data?.session?.status?.(props.sessionID) === "running";
      createEffect(on(() => props.sessionID, sessionID => {
        activeSessionID = sessionID;
        sessionGen += 1;
        latestState = {
          snapshot: null,
          nativeTokens: null,
          nativeLimit: null,
          sessionCreatedAt: null,
          history: null,
          compDetails: null,
          msgBreakdown: null
        };
        setSnapshot(null);
        setFailed(false);
        setNativeTokens(null);
        setNativeLimit(null);
        setSessionCreatedAt(null);
        setHistory(null);
        setCompDetails(null);
        setMsgBreakdown(null);
        if (!sessionID) return;
        let seq = 0;
        let disposed = false;
        let inFlight = false;
        let rerunPending = false;
        let timer;
        let messagesSynced = false;
        let modelsSynced = false;
        let hiddenRetries = 0;
        let hiddenStopped = false;
        let lastMsgKey = "";
        let lastHadServerBreakdown = false;
        let lastNowTick = Date.now();
        const resolveSessionMeta = async id => {
          const session = await Promise.resolve(context.data?.session?.get?.(id));
          const rawCreated = session?.time?.created;
          const createdAt = typeof rawCreated === "number" && Number.isFinite(rawCreated) && rawCreated > 0 ? rawCreated : null;
          const ref = session?.model;
          if (!ref) return {
            limit: null,
            createdAt
          };
          const models = context.data?.location?.model;
          if (!models || typeof models.list !== "function") return {
            limit: null,
            createdAt
          };
          const find = list => Array.isArray(list) ? list.find(m => m?.providerID === ref.providerID && (m?.id === ref.id || m?.modelID === ref.id)) : undefined;
          let found = find(await Promise.resolve(models.list(context.location)));
          if (!found && !modelsSynced && typeof models.sync === "function") {
            modelsSynced = true;
            await Promise.resolve(models.sync(context.location));
            found = find(await Promise.resolve(models.list(context.location)));
          }
          const v = found?.limit?.input ?? found?.limit?.context;
          const limit = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
          return {
            limit,
            createdAt
          };
        };
        const fetchNow = async () => {
          if (disposed) return;
          if (inFlight) {
            rerunPending = true;
            return;
          }
          inFlight = true;
          try {
            const mine = ++seq;
            // Probe RPC first: when server tui.enabled is false, avoid unnecessary message/model sync calls.
            let next;
            try {
              next = await rpc.snapshot({
                sessionID
              }, context.location ? {
                location: context.location
              } : undefined);
              if (disposed || mine !== seq) return;
              if (next && typeof next.sessionID === "string" && next.sessionID !== sessionID) {
                next = null;
              }
              setSnapshot(next ?? null);
              latestState.snapshot = next ?? null;
              setFailed(next == null);
              if (next != null) {
                setVisible(true);
                hiddenRetries = 0;
                hiddenStopped = false;
              } else if (!visible()) {
                hiddenRetries += 1;
                if (hiddenRetries >= MAX_HIDDEN_RETRIES) hiddenStopped = true;
                return;
              }
              lastNowTick = Date.now();
              setNow(lastNowTick);
            } catch (err) {
              if (disposed || mine !== seq) return;
              setFailed(true);
              lastNowTick = Date.now();
              setNow(lastNowTick);
              if (!visible()) {
                hiddenRetries += 1;
                if (isRpcUnavailable(err) || hiddenRetries >= MAX_HIDDEN_RETRIES) hiddenStopped = true;
                return;
              }
            }
            if (!visible()) return;
            const hasServerBreakdown = Boolean(next?.context?.breakdown);
            try {
              const messages = context.data?.session?.message;
              if (messages && typeof messages.list === "function") {
                let list = await Promise.resolve(messages.list(sessionID));
                let msgKey = messageListKey(list);
                const unchanged = msgKey === lastMsgKey && (hasServerBreakdown || !lastHadServerBreakdown);
                if (!unchanged) {
                  let tokens = nativeContextTokens(list);
                  if (tokens === null && !messagesSynced && typeof messages.sync === "function") {
                    // The TUI message cache is empty until synced; sync at most once per session mount.
                    messagesSynced = true;
                    try {
                      await Promise.resolve(messages.sync(sessionID));
                    } catch {}
                    list = await Promise.resolve(messages.list(sessionID));
                    msgKey = messageListKey(list);
                    tokens = nativeContextTokens(list);
                  }
                  if (!disposed && mine === seq) {
                    const hist = compactionHistory(list);
                    const details = compactionBreakdown(list);
                    const breakdown = hasServerBreakdown ? null : messageBreakdown(list);
                    lastMsgKey = msgKey;
                    lastHadServerBreakdown = hasServerBreakdown;
                    setNativeTokens(tokens);
                    setHistory(hist);
                    setCompDetails(details);
                    setMsgBreakdown(breakdown);
                    latestState.nativeTokens = tokens;
                    latestState.history = hist;
                    latestState.compDetails = details;
                    latestState.msgBreakdown = breakdown;
                  }
                } else if (hasServerBreakdown && !lastHadServerBreakdown && !disposed && mine === seq) {
                  lastHadServerBreakdown = true;
                  setMsgBreakdown(null);
                  latestState.msgBreakdown = null;
                }
              }
            } catch {
              if (!disposed && mine === seq) {
                lastMsgKey = "";
                lastHadServerBreakdown = false;
                setNativeTokens(null);
                setHistory(null);
                setCompDetails(null);
                setMsgBreakdown(null);
                latestState.nativeTokens = null;
                latestState.history = null;
                latestState.compDetails = null;
                latestState.msgBreakdown = null;
              }
            }
            try {
              const meta = await resolveSessionMeta(sessionID);
              if (!disposed && mine === seq) {
                setNativeLimit(meta.limit);
                setSessionCreatedAt(meta.createdAt);
                latestState.nativeLimit = meta.limit;
                latestState.sessionCreatedAt = meta.createdAt;
              }
            } catch {
              if (!disposed && mine === seq) {
                setNativeLimit(null);
                setSessionCreatedAt(null);
                latestState.nativeLimit = null;
                latestState.sessionCreatedAt = null;
              }
            }
          } finally {
            inFlight = false;
            if (rerunPending && !disposed) {
              rerunPending = false;
              schedule();
            }
          }
        };
        const schedule = () => {
          if (disposed) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(fetchNow, DEBOUNCE_MS);
        };
        const unsubs = [];
        try {
          const off = rpc.events?.on?.("changed", event => {
            if (foreign(event)) return;
            if (normalizeEventSessionID(event) === sessionID) schedule();
          });
          if (typeof off === "function") unsubs.push(off);
        } catch {}
        for (const type of REFRESH_EVENTS) {
          try {
            const off = context.data?.on?.(type, event => {
              if (foreign(event)) return;
              if (normalizeEventSessionID(event) !== sessionID) return;
              schedule();
            });
            if (typeof off === "function") unsubs.push(off);
          } catch {}
        }
        for (const type of RELOAD_EVENTS) {
          try {
            const off = context.data?.on?.(type, event => {
              if (foreign(event)) return;
              hiddenStopped = false;
              hiddenRetries = 0;
              modelsSynced = false;
              schedule();
            });
            if (typeof off === "function") unsubs.push(off);
          } catch {}
        }
        void fetchNow();
        // Single unified interval: refreshes running sessions, ages relative timestamps, and stops retrying when RPC is off.
        const watcher = setInterval(() => {
          if (disposed) return;
          const nowMs = Date.now();
          if (visible()) {
            if (running()) {
              lastNowTick = nowMs;
              setNow(nowMs);
              void fetchNow();
            } else if (nowMs - lastNowTick >= IDLE_TICK_MS) {
              lastNowTick = nowMs;
              setNow(nowMs);
            }
          } else if (!hiddenStopped) {
            lastNowTick = nowMs;
            setNow(nowMs);
            void fetchNow();
          }
        }, POLL_MS);
        watcher.unref?.();
        onCleanup(() => {
          disposed = true;
          seq++;
          if (activeSessionID === sessionID) activeSessionID = undefined;
          if (timer) clearTimeout(timer);
          clearInterval(watcher);
          for (const off of unsubs) {
            try {
              off();
            } catch {}
          }
        });
      }));
      const stale = createMemo(() => failed() || isStale(snapshot(), now(), running()));
      const header = createMemo(() => buildHeader(snapshot(), {
        expanded: viewMode() !== "collapsed",
        stale: stale(),
        nativeTokens: nativeTokens(),
        nativeLimitTokens: nativeLimit()
      }));
      const model = createMemo(() => buildSidebarModel(snapshot(), now(), {
        nativeTokens: nativeTokens(),
        nativeLimitTokens: nativeLimit(),
        sessionCreatedAt: sessionCreatedAt(),
        compactionHistory: history(),
        compactionBreakdown: compDetails(),
        messageBreakdown: msgBreakdown()
      }));
      const collapsedSegments = createMemo(() => model().segments(COLLAPSED_BAR_WIDTH));
      const expandedSegments = createMemo(() => model().segments(EXPANDED_BAR_WIDTH));
      return _$createComponent(Show, {
        get when() {
          return visible();
        },
        get children() {
          var _el$0 = _$createElement("box");
          _$setProp(_el$0, "flexDirection", "column");
          _$setProp(_el$0, "flexShrink", 0);
          _$setProp(_el$0, "width", "100%");
          _$setProp(_el$0, "gap", 0);
          _$insert(_el$0, _$createComponent(Show, {
            get when() {
              return viewMode() !== "collapsed";
            },
            get fallback() {
              return (() => {
                var _el$37 = _$createElement("box"),
                  _el$38 = _$createElement("box"),
                  _el$39 = _$createElement("text"),
                  _el$41 = _$createElement("box"),
                  _el$42 = _$createElement("text"),
                  _el$44 = _$createElement("box"),
                  _el$45 = _$createElement("box"),
                  _el$46 = _$createElement("text"),
                  _el$47 = _$createElement("b");
                _$insertNode(_el$37, _el$38);
                _$insertNode(_el$37, _el$44);
                _$insertNode(_el$37, _el$45);
                _$setProp(_el$37, "width", "100%");
                _$setProp(_el$37, "flexDirection", "row");
                _$setProp(_el$37, "justifyContent", "space-between");
                _$setProp(_el$37, "alignItems", "center");
                _$setProp(_el$37, "flexShrink", 0);
                _$setProp(_el$37, "onMouseUp", toggle);
                _$insertNode(_el$38, _el$39);
                _$insertNode(_el$38, _el$41);
                _$setProp(_el$38, "flexDirection", "row");
                _$setProp(_el$38, "alignItems", "center");
                _$setProp(_el$38, "flexShrink", 0);
                _$insertNode(_el$39, _$createTextNode(`▶ `));
                _$setProp(_el$39, "wrapMode", "none");
                _$insertNode(_el$41, _el$42);
                _$setProp(_el$41, "paddingLeft", 1);
                _$setProp(_el$41, "paddingRight", 1);
                _$insertNode(_el$42, _$createTextNode(`trim`));
                _$setProp(_el$42, "wrapMode", "none");
                _$setProp(_el$44, "flexGrow", 1);
                _$setProp(_el$44, "flexDirection", "row");
                _$setProp(_el$44, "justifyContent", "center");
                _$setProp(_el$44, "alignItems", "center");
                _$setProp(_el$44, "marginLeft", 1);
                _$setProp(_el$44, "marginRight", 1);
                _$insert(_el$44, _$createComponent(SegmentedBar, {
                  get segments() {
                    return collapsedSegments();
                  },
                  get sysColor() {
                    return sysColor();
                  },
                  get chatColor() {
                    return chatColor();
                  },
                  get toolsColor() {
                    return okColor();
                  },
                  get emptyColor() {
                    return faint();
                  }
                }));
                _$insertNode(_el$45, _el$46);
                _$setProp(_el$45, "flexDirection", "row");
                _$setProp(_el$45, "alignItems", "center");
                _$setProp(_el$45, "flexShrink", 0);
                _$insertNode(_el$46, _el$47);
                _$setProp(_el$46, "wrapMode", "none");
                _$insert(_el$47, () => model().context.percentText);
                _$insert(_el$45, _$createComponent(Show, {
                  get when() {
                    return header().marker;
                  },
                  get children() {
                    var _el$48 = _$createElement("text");
                    _$setProp(_el$48, "wrapMode", "none");
                    _$insert(_el$48, () => " " + header().marker);
                    _$effect(_$p => _$setProp(_el$48, "fg", tone("warning"), _$p));
                    return _el$48;
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$12 = muted(),
                    _v$13 = badgeColor(),
                    _v$14 = bgColor(),
                    _v$15 = tone(model().health.tone);
                  _v$12 !== _p$.e && (_p$.e = _$setProp(_el$39, "fg", _v$12, _p$.e));
                  _v$13 !== _p$.t && (_p$.t = _$setProp(_el$41, "backgroundColor", _v$13, _p$.t));
                  _v$14 !== _p$.a && (_p$.a = _$setProp(_el$42, "fg", _v$14, _p$.a));
                  _v$15 !== _p$.o && (_p$.o = _$setProp(_el$46, "fg", _v$15, _p$.o));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined,
                  o: undefined
                });
                return _el$37;
              })();
            },
            get children() {
              return [(() => {
                var _el$1 = _$createElement("box"),
                  _el$10 = _$createElement("text"),
                  _el$12 = _$createElement("box"),
                  _el$13 = _$createElement("text"),
                  _el$15 = _$createElement("text"),
                  _el$16 = _$createElement("text");
                _$insertNode(_el$1, _el$10);
                _$insertNode(_el$1, _el$12);
                _$insertNode(_el$1, _el$15);
                _$insertNode(_el$1, _el$16);
                _$setProp(_el$1, "width", "100%");
                _$setProp(_el$1, "flexDirection", "row");
                _$setProp(_el$1, "alignItems", "center");
                _$setProp(_el$1, "flexShrink", 0);
                _$setProp(_el$1, "onMouseUp", toggle);
                _$insertNode(_el$10, _$createTextNode(`▼ `));
                _$setProp(_el$10, "wrapMode", "none");
                _$insertNode(_el$12, _el$13);
                _$setProp(_el$12, "paddingLeft", 1);
                _$setProp(_el$12, "paddingRight", 1);
                _$insertNode(_el$13, _$createTextNode(`trim`));
                _$setProp(_el$13, "wrapMode", "none");
                _$setProp(_el$15, "wrapMode", "none");
                _$insert(_el$15, " v" + TRIM_VERSION);
                _$setProp(_el$16, "flexShrink", 1);
                _$setProp(_el$16, "wrapMode", "none");
                _$insert(_el$16, () => " · ● " + model().health.label);
                _$insert(_el$1, _$createComponent(Show, {
                  get when() {
                    return header().marker;
                  },
                  get children() {
                    var _el$17 = _$createElement("text");
                    _$setProp(_el$17, "flexShrink", 0);
                    _$setProp(_el$17, "wrapMode", "none");
                    _$insert(_el$17, () => " " + header().marker);
                    _$effect(_$p => _$setProp(_el$17, "fg", tone("warning"), _$p));
                    return _el$17;
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$3 = muted(),
                    _v$4 = badgeColor(),
                    _v$5 = bgColor(),
                    _v$6 = muted(),
                    _v$7 = tone(model().health.tone);
                  _v$3 !== _p$.e && (_p$.e = _$setProp(_el$10, "fg", _v$3, _p$.e));
                  _v$4 !== _p$.t && (_p$.t = _$setProp(_el$12, "backgroundColor", _v$4, _p$.t));
                  _v$5 !== _p$.a && (_p$.a = _$setProp(_el$13, "fg", _v$5, _p$.a));
                  _v$6 !== _p$.o && (_p$.o = _$setProp(_el$15, "fg", _v$6, _p$.o));
                  _v$7 !== _p$.i && (_p$.i = _$setProp(_el$16, "fg", _v$7, _p$.i));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined,
                  o: undefined,
                  i: undefined
                });
                return _el$1;
              })(), (() => {
                var _el$18 = _$createElement("box"),
                  _el$19 = _$createElement("box"),
                  _el$20 = _$createElement("box"),
                  _el$21 = _$createElement("box"),
                  _el$22 = _$createElement("text"),
                  _el$24 = _$createElement("text"),
                  _el$25 = _$createElement("b"),
                  _el$26 = _$createElement("box"),
                  _el$27 = _$createElement("text"),
                  _el$29 = _$createElement("text"),
                  _el$30 = _$createElement("b"),
                  _el$31 = _$createElement("box"),
                  _el$32 = _$createElement("text"),
                  _el$34 = _$createElement("text"),
                  _el$35 = _$createElement("b");
                _$insertNode(_el$18, _el$19);
                _$insertNode(_el$18, _el$20);
                _$setProp(_el$18, "width", "100%");
                _$setProp(_el$18, "flexDirection", "column");
                _$setProp(_el$18, "paddingLeft", 1);
                _$setProp(_el$18, "paddingRight", 1);
                _$setProp(_el$18, "gap", 0);
                _$setProp(_el$19, "width", "100%");
                _$setProp(_el$19, "flexDirection", "row");
                _$setProp(_el$19, "justifyContent", "center");
                _$setProp(_el$19, "alignItems", "center");
                _$setProp(_el$19, "flexShrink", 0);
                _$setProp(_el$19, "marginTop", 1);
                _$insert(_el$19, _$createComponent(SegmentedBar, {
                  get segments() {
                    return expandedSegments();
                  },
                  get sysColor() {
                    return sysColor();
                  },
                  get chatColor() {
                    return chatColor();
                  },
                  get toolsColor() {
                    return okColor();
                  },
                  get emptyColor() {
                    return faint();
                  }
                }));
                _$insertNode(_el$20, _el$21);
                _$insertNode(_el$20, _el$26);
                _$insertNode(_el$20, _el$31);
                _$setProp(_el$20, "width", "100%");
                _$setProp(_el$20, "flexDirection", "row");
                _$setProp(_el$20, "justifyContent", "space-between");
                _$setProp(_el$20, "alignItems", "center");
                _$setProp(_el$20, "flexShrink", 0);
                _$insertNode(_el$21, _el$22);
                _$insertNode(_el$21, _el$24);
                _$setProp(_el$21, "flexDirection", "row");
                _$setProp(_el$21, "alignItems", "center");
                _$setProp(_el$21, "flexShrink", 0);
                _$insertNode(_el$22, _$createTextNode(`sys `));
                _$setProp(_el$22, "wrapMode", "none");
                _$insertNode(_el$24, _el$25);
                _$setProp(_el$24, "wrapMode", "none");
                _$insert(_el$25, () => model().composition.sysText);
                _$insertNode(_el$26, _el$27);
                _$insertNode(_el$26, _el$29);
                _$setProp(_el$26, "flexDirection", "row");
                _$setProp(_el$26, "alignItems", "center");
                _$setProp(_el$26, "flexShrink", 0);
                _$insertNode(_el$27, _$createTextNode(`chat `));
                _$setProp(_el$27, "wrapMode", "none");
                _$insertNode(_el$29, _el$30);
                _$setProp(_el$29, "wrapMode", "none");
                _$insert(_el$30, () => model().composition.chatText);
                _$insertNode(_el$31, _el$32);
                _$insertNode(_el$31, _el$34);
                _$setProp(_el$31, "flexDirection", "row");
                _$setProp(_el$31, "alignItems", "center");
                _$setProp(_el$31, "flexShrink", 0);
                _$insertNode(_el$32, _$createTextNode(`tools `));
                _$setProp(_el$32, "wrapMode", "none");
                _$insertNode(_el$34, _el$35);
                _$setProp(_el$34, "wrapMode", "none");
                _$insert(_el$35, () => model().composition.toolsText);
                _$insert(_el$18, _$createComponent(Show, {
                  get when() {
                    return viewMode() === "default";
                  },
                  get children() {
                    return _$createComponent(For, {
                      get each() {
                        return model().normalRows;
                      },
                      children: row => _$createComponent(StatRow, {
                        get label() {
                          return row.label;
                        },
                        get value() {
                          return row.parts.join(" · ");
                        },
                        get labelColor() {
                          return muted();
                        },
                        get valueColor() {
                          return tone(row.tone);
                        }
                      })
                    });
                  }
                }), null);
                _$insert(_el$18, _$createComponent(Show, {
                  get when() {
                    return viewMode() === "expanded";
                  },
                  get children() {
                    return _$createComponent(For, {
                      get each() {
                        return model().detailRows;
                      },
                      children: row => _$createComponent(StatRow, {
                        get label() {
                          return row.label;
                        },
                        get value() {
                          return row.parts.join(" · ");
                        },
                        get labelColor() {
                          return muted();
                        },
                        get valueColor() {
                          return tone(row.tone);
                        }
                      })
                    });
                  }
                }), null);
                _$insert(_el$18, _$createComponent(Show, {
                  get when() {
                    return stale();
                  },
                  get children() {
                    var _el$36 = _$createElement("text");
                    _$setProp(_el$36, "flexShrink", 1);
                    _$setProp(_el$36, "wrapMode", "none");
                    _$insert(_el$36, () => failed() ? "stats unavailable" : "stats stale");
                    _$effect(_$p => _$setProp(_el$36, "fg", theme?.text?.faint ?? muted(), _$p));
                    return _el$36;
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$8 = sysColor(),
                    _v$9 = base(),
                    _v$0 = chatColor(),
                    _v$1 = base(),
                    _v$10 = okColor(),
                    _v$11 = base();
                  _v$8 !== _p$.e && (_p$.e = _$setProp(_el$22, "fg", _v$8, _p$.e));
                  _v$9 !== _p$.t && (_p$.t = _$setProp(_el$24, "fg", _v$9, _p$.t));
                  _v$0 !== _p$.a && (_p$.a = _$setProp(_el$27, "fg", _v$0, _p$.a));
                  _v$1 !== _p$.o && (_p$.o = _$setProp(_el$29, "fg", _v$1, _p$.o));
                  _v$10 !== _p$.i && (_p$.i = _$setProp(_el$32, "fg", _v$10, _p$.i));
                  _v$11 !== _p$.n && (_p$.n = _$setProp(_el$34, "fg", _v$11, _p$.n));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined,
                  o: undefined,
                  i: undefined,
                  n: undefined
                });
                return _el$18;
              })()];
            }
          }));
          return _el$0;
        }
      });
    }
    const runTrimCommand = async rawArg => {
      const arg = typeof rawArg === "string" ? rawArg.trim().toLowerCase() : "";
      if (arg === "minimal" || arg === "collapsed") {
        setViewMode("collapsed");
        context.ui?.toast?.show?.({
          title: "Trim",
          message: "Sidebar set to minimal"
        });
        return;
      }
      if (arg === "normal" || arg === "default") {
        setViewMode("default");
        context.ui?.toast?.show?.({
          title: "Trim",
          message: "Sidebar set to normal"
        });
        return;
      }
      if (arg === "detail" || arg === "expanded") {
        setViewMode("expanded");
        context.ui?.toast?.show?.({
          title: "Trim",
          message: "Sidebar set to detail"
        });
        return;
      }
      if (arg === "toggle") {
        const next = nextViewMode(viewMode());
        setViewMode(next);
        context.ui?.toast?.show?.({
          title: "Trim",
          message: "Sidebar set to " + next
        });
        return;
      }
      const targetSessionID = activeSessionID;
      const capturedGen = sessionGen;
      const capturedState = {
        ...latestState
      };
      let snap = capturedState.snapshot;
      if (targetSessionID) {
        try {
          const fresh = await rpc.snapshot({
            sessionID: targetSessionID
          }, context.location ? {
            location: context.location
          } : undefined);
          if (fresh && (!fresh.sessionID || fresh.sessionID === targetSessionID)) snap = fresh;
        } catch {}
      }
      const sameSession = activeSessionID === targetSessionID && sessionGen === capturedGen;
      const stateForReport = sameSession ? latestState : capturedState;
      const report = buildGainReport(snap, Date.now(), {
        nativeTokens: stateForReport.nativeTokens,
        nativeLimitTokens: stateForReport.nativeLimit,
        sessionCreatedAt: stateForReport.sessionCreatedAt,
        compactionHistory: stateForReport.history,
        compactionBreakdown: stateForReport.compDetails,
        messageBreakdown: stateForReport.msgBreakdown
      });
      if (typeof context.ui?.dialog?.alert === "function") {
        await context.ui.dialog.alert({
          title: "Trim v" + TRIM_VERSION,
          message: report
        });
      } else {
        context.ui?.toast?.show?.({
          title: "Trim v" + TRIM_VERSION,
          message: report
        });
      }
    };
    let disposeSlot;
    let disposeKeymap;
    try {
      disposeSlot = context.ui.slot({
        append: "sidebar.content",
        render: input => _$createComponent(TrimSidebar, {
          get sessionID() {
            return input?.sessionID;
          }
        })
      });
    } catch {
      return () => {};
    }
    try {
      if (typeof context.keymap?.layer === "function") {
        disposeKeymap = context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [{
            id: "opencode-trim.status",
            title: "Trim status and savings",
            group: "Trim",
            palette: true,
            slash: {
              name: "trim",
              aliases: ["trim-gain"],
              arguments: true
            },
            enabled: () => true,
            run: runTrimCommand
          }],
          bindings: []
        }));
      }
    } catch {
      disposeKeymap = undefined;
    }
    return () => {
      try {
        if (typeof disposeKeymap === "function") disposeKeymap();else if (disposeKeymap && typeof disposeKeymap.dispose === "function") disposeKeymap.dispose();
      } catch {}
      try {
        if (typeof disposeSlot === "function") disposeSlot();else if (disposeSlot && typeof disposeSlot.dispose === "function") disposeSlot.dispose();
      } catch {}
    };
  }
});
