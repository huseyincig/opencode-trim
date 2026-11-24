import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
// Optional OpenCode V2 TUI sidebar: hidden until the server stats RPC answers; options.tui.enabled === false opts out.
// Read-only view of the server stats RPC; never touches server internals.
import { Plugin } from "opentui:runtime-module:%40opencode%2Fplugin%2Ftui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "opentui:runtime-module:solid-js";
import { TRIM_STATS_RPC } from "./stats-rpc.js";
import { buildHeader, buildSidebarModel, compactionBreakdown, compactionHistory, isStale, messageBreakdown, nativeContextTokens, nextViewMode, normalizeEventSessionID, normalizeViewMode, STORAGE_KEY, TRIM_VERSION } from "./tui-model.js";
const DEBOUNCE_MS = 150;
const POLL_MS = 2000;
const MAX_HIDDEN_RETRIES = 3;
const COLLAPSED_BAR_WIDTH = 18;
const EXPANDED_BAR_WIDTH = 32;
const REFRESH_EVENTS = ["session.compaction.started", "session.compaction.ended", "session.compaction.failed", "session.step.ended"];
const RELOAD_EVENTS = ["plugin.updated", "model.updated", "provider.updated"];
function normDir(v) {
  if (typeof v !== "string" || !v) return undefined;
  const s = v.replace(/[\\/]+$/, "");
  return s || "/";
}
function isRpcUnavailable(err) {
  const msg = String(err?.message ?? err?.code ?? err ?? "").toLowerCase();
  return msg.includes("rpc.unavailable") || msg.includes("unavailable") || msg.includes("404") || msg.includes("not found");
}
function SegmentedBar(props) {
  const s = () => props.segments;
  return (() => {
    var _el$ = _$createElement("box");
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "flexShrink", 1);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return s().sys > 0;
      },
      get children() {
        var _el$2 = _$createElement("text");
        _$setProp(_el$2, "wrapMode", "none");
        _$insert(_el$2, () => "█".repeat(s().sys));
        _$effect(_$p => _$setProp(_el$2, "fg", props.sysColor, _$p));
        return _el$2;
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return s().chat > 0;
      },
      get children() {
        var _el$3 = _$createElement("text");
        _$setProp(_el$3, "wrapMode", "none");
        _$insert(_el$3, () => "█".repeat(s().chat));
        _$effect(_$p => _$setProp(_el$3, "fg", props.chatColor, _$p));
        return _el$3;
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return s().tools > 0;
      },
      get children() {
        var _el$4 = _$createElement("text");
        _$setProp(_el$4, "wrapMode", "none");
        _$insert(_el$4, () => "█".repeat(s().tools));
        _$effect(_$p => _$setProp(_el$4, "fg", props.toolsColor, _$p));
        return _el$4;
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return s().empty > 0;
      },
      get children() {
        var _el$5 = _$createElement("text");
        _$setProp(_el$5, "wrapMode", "none");
        _$insert(_el$5, () => "█".repeat(s().empty));
        _$effect(_$p => _$setProp(_el$5, "fg", props.emptyColor, _$p));
        return _el$5;
      }
    }), null);
    return _el$;
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
    const toggle = () => {
      try {
        void Promise.resolve(updateStored(draft => {
          const next = nextViewMode(normalizeViewMode(draft));
          draft.mode = next;
          draft.expanded = next === "expanded";
        })).catch(() => {});
      } catch {}
    };
    const theme = context.theme;
    const base = () => theme?.text?.base ?? "white";
    const muted = () => theme?.text?.muted ?? base();
    const faint = () => theme?.text?.faint ?? "#3f434a";
    const sysColor = () => theme?.syntax?.keyword ?? theme?.text?.accent?.base ?? "#a875ff";
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
        let timer;
        let messagesSynced = false;
        let modelsSynced = false;
        let hiddenRetries = 0;
        let hiddenStopped = false;
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
          const v = found?.limit?.context;
          const limit = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
          return {
            limit,
            createdAt
          };
        };
        const fetchNow = async () => {
          if (disposed) return;
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
            setSnapshot(next ?? null);
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
            setNow(Date.now());
          } catch (err) {
            if (disposed || mine !== seq) return;
            setFailed(true);
            setNow(Date.now());
            if (!visible()) {
              hiddenRetries += 1;
              if (isRpcUnavailable(err) || hiddenRetries >= MAX_HIDDEN_RETRIES) hiddenStopped = true;
              return;
            }
          }
          if (!visible()) return;
          try {
            const messages = context.data?.session?.message;
            if (messages && typeof messages.list === "function") {
              let list = await Promise.resolve(messages.list(sessionID));
              let tokens = nativeContextTokens(list);
              if (tokens === null && !messagesSynced && typeof messages.sync === "function") {
                // The TUI message cache is empty until synced; sync at most once per session mount.
                messagesSynced = true;
                try {
                  await Promise.resolve(messages.sync(sessionID));
                } catch {}
                list = await Promise.resolve(messages.list(sessionID));
                tokens = nativeContextTokens(list);
              }
              if (!disposed && mine === seq) {
                setNativeTokens(tokens);
                setHistory(compactionHistory(list));
                setCompDetails(compactionBreakdown(list));
                setMsgBreakdown(messageBreakdown(list));
              }
            }
          } catch {
            if (!disposed && mine === seq) {
              setNativeTokens(null);
              setHistory(null);
              setCompDetails(null);
              setMsgBreakdown(null);
            }
          }
          try {
            const meta = await resolveSessionMeta(sessionID);
            if (!disposed && mine === seq) {
              setNativeLimit(meta.limit);
              setSessionCreatedAt(meta.createdAt);
            }
          } catch {
            if (!disposed && mine === seq) {
              setNativeLimit(null);
              setSessionCreatedAt(null);
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
          setNow(Date.now());
          if (visible()) {
            if (running()) void fetchNow();
          } else if (!hiddenStopped) {
            void fetchNow();
          }
        }, POLL_MS);
        watcher.unref?.();
        onCleanup(() => {
          disposed = true;
          seq++;
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
          var _el$6 = _$createElement("box");
          _$setProp(_el$6, "flexDirection", "column");
          _$setProp(_el$6, "flexShrink", 0);
          _$setProp(_el$6, "width", "100%");
          _$setProp(_el$6, "gap", 0);
          _$insert(_el$6, _$createComponent(Show, {
            get when() {
              return viewMode() !== "collapsed";
            },
            get fallback() {
              return (() => {
                var _el$38 = _$createElement("box"),
                  _el$39 = _$createElement("box"),
                  _el$40 = _$createElement("text"),
                  _el$42 = _$createElement("text"),
                  _el$43 = _$createElement("b"),
                  _el$45 = _$createElement("box"),
                  _el$46 = _$createElement("box"),
                  _el$47 = _$createElement("text"),
                  _el$48 = _$createElement("b");
                _$insertNode(_el$38, _el$39);
                _$insertNode(_el$38, _el$45);
                _$insertNode(_el$38, _el$46);
                _$setProp(_el$38, "width", "100%");
                _$setProp(_el$38, "flexDirection", "row");
                _$setProp(_el$38, "justifyContent", "space-between");
                _$setProp(_el$38, "alignItems", "center");
                _$setProp(_el$38, "flexShrink", 0);
                _$setProp(_el$38, "onMouseUp", toggle);
                _$insertNode(_el$39, _el$40);
                _$insertNode(_el$39, _el$42);
                _$setProp(_el$39, "flexDirection", "row");
                _$setProp(_el$39, "alignItems", "center");
                _$setProp(_el$39, "flexShrink", 0);
                _$insertNode(_el$40, _$createTextNode(`▶ `));
                _$setProp(_el$40, "wrapMode", "none");
                _$insertNode(_el$42, _el$43);
                _$setProp(_el$42, "wrapMode", "none");
                _$insertNode(_el$43, _$createTextNode(`Trim`));
                _$setProp(_el$45, "flexDirection", "row");
                _$setProp(_el$45, "alignItems", "center");
                _$setProp(_el$45, "flexShrink", 1);
                _$setProp(_el$45, "marginLeft", 1);
                _$insert(_el$45, _$createComponent(SegmentedBar, {
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
                _$insertNode(_el$46, _el$47);
                _$setProp(_el$46, "flexDirection", "row");
                _$setProp(_el$46, "alignItems", "center");
                _$setProp(_el$46, "flexShrink", 0);
                _$setProp(_el$46, "marginLeft", 1);
                _$insertNode(_el$47, _el$48);
                _$setProp(_el$47, "wrapMode", "none");
                _$insert(_el$48, () => model().context.percentText);
                _$insert(_el$46, _$createComponent(Show, {
                  get when() {
                    return header().marker;
                  },
                  get children() {
                    var _el$49 = _$createElement("text");
                    _$setProp(_el$49, "wrapMode", "none");
                    _$insert(_el$49, () => " " + header().marker);
                    _$effect(_$p => _$setProp(_el$49, "fg", tone("warning"), _$p));
                    return _el$49;
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$10 = muted(),
                    _v$11 = base(),
                    _v$12 = tone(model().health.tone);
                  _v$10 !== _p$.e && (_p$.e = _$setProp(_el$40, "fg", _v$10, _p$.e));
                  _v$11 !== _p$.t && (_p$.t = _$setProp(_el$42, "fg", _v$11, _p$.t));
                  _v$12 !== _p$.a && (_p$.a = _$setProp(_el$47, "fg", _v$12, _p$.a));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined
                });
                return _el$38;
              })();
            },
            get children() {
              return [(() => {
                var _el$7 = _$createElement("box"),
                  _el$8 = _$createElement("box"),
                  _el$9 = _$createElement("text"),
                  _el$1 = _$createElement("text"),
                  _el$10 = _$createElement("b"),
                  _el$12 = _$createElement("box"),
                  _el$13 = _$createElement("text");
                _$insertNode(_el$7, _el$8);
                _$insertNode(_el$7, _el$12);
                _$setProp(_el$7, "width", "100%");
                _$setProp(_el$7, "flexDirection", "row");
                _$setProp(_el$7, "justifyContent", "space-between");
                _$setProp(_el$7, "alignItems", "center");
                _$setProp(_el$7, "flexShrink", 0);
                _$setProp(_el$7, "onMouseUp", toggle);
                _$insertNode(_el$8, _el$9);
                _$insertNode(_el$8, _el$1);
                _$setProp(_el$8, "flexDirection", "row");
                _$setProp(_el$8, "alignItems", "center");
                _$insertNode(_el$9, _$createTextNode(`▼ `));
                _$setProp(_el$9, "wrapMode", "none");
                _$insertNode(_el$1, _el$10);
                _$setProp(_el$1, "wrapMode", "none");
                _$insertNode(_el$10, _$createTextNode(`Trim`));
                _$insertNode(_el$12, _el$13);
                _$setProp(_el$12, "flexDirection", "row");
                _$setProp(_el$12, "alignItems", "center");
                _$setProp(_el$13, "wrapMode", "none");
                _$insert(_el$13, "v" + TRIM_VERSION);
                _$insert(_el$12, _$createComponent(Show, {
                  get when() {
                    return header().marker;
                  },
                  get children() {
                    var _el$14 = _$createElement("text");
                    _$setProp(_el$14, "wrapMode", "none");
                    _$insert(_el$14, () => " " + header().marker);
                    _$effect(_$p => _$setProp(_el$14, "fg", tone("warning"), _$p));
                    return _el$14;
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$ = muted(),
                    _v$2 = base(),
                    _v$3 = muted();
                  _v$ !== _p$.e && (_p$.e = _$setProp(_el$9, "fg", _v$, _p$.e));
                  _v$2 !== _p$.t && (_p$.t = _$setProp(_el$1, "fg", _v$2, _p$.t));
                  _v$3 !== _p$.a && (_p$.a = _$setProp(_el$13, "fg", _v$3, _p$.a));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined
                });
                return _el$7;
              })(), (() => {
                var _el$15 = _$createElement("box");
                _$setProp(_el$15, "width", "100%");
                _$setProp(_el$15, "flexDirection", "row");
                _$setProp(_el$15, "alignItems", "center");
                _$setProp(_el$15, "flexShrink", 0);
                _$insert(_el$15, _$createComponent(SegmentedBar, {
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
                return _el$15;
              })(), (() => {
                var _el$16 = _$createElement("box"),
                  _el$17 = _$createElement("box"),
                  _el$18 = _$createElement("text"),
                  _el$20 = _$createElement("text"),
                  _el$21 = _$createElement("box"),
                  _el$22 = _$createElement("text"),
                  _el$24 = _$createElement("text"),
                  _el$25 = _$createElement("box"),
                  _el$26 = _$createElement("text"),
                  _el$28 = _$createElement("text");
                _$insertNode(_el$16, _el$17);
                _$insertNode(_el$16, _el$21);
                _$insertNode(_el$16, _el$25);
                _$setProp(_el$16, "width", "100%");
                _$setProp(_el$16, "flexDirection", "row");
                _$setProp(_el$16, "justifyContent", "space-between");
                _$setProp(_el$16, "alignItems", "center");
                _$setProp(_el$16, "flexShrink", 0);
                _$insertNode(_el$17, _el$18);
                _$insertNode(_el$17, _el$20);
                _$setProp(_el$17, "flexDirection", "row");
                _$setProp(_el$17, "alignItems", "center");
                _$setProp(_el$17, "flexShrink", 0);
                _$insertNode(_el$18, _$createTextNode(`sys `));
                _$setProp(_el$18, "wrapMode", "none");
                _$setProp(_el$20, "wrapMode", "none");
                _$insert(_el$20, () => model().composition.sysText);
                _$insertNode(_el$21, _el$22);
                _$insertNode(_el$21, _el$24);
                _$setProp(_el$21, "flexDirection", "row");
                _$setProp(_el$21, "alignItems", "center");
                _$setProp(_el$21, "flexShrink", 0);
                _$insertNode(_el$22, _$createTextNode(`chat `));
                _$setProp(_el$22, "wrapMode", "none");
                _$setProp(_el$24, "wrapMode", "none");
                _$insert(_el$24, () => model().composition.chatText);
                _$insertNode(_el$25, _el$26);
                _$insertNode(_el$25, _el$28);
                _$setProp(_el$25, "flexDirection", "row");
                _$setProp(_el$25, "alignItems", "center");
                _$setProp(_el$25, "flexShrink", 0);
                _$insertNode(_el$26, _$createTextNode(`tools `));
                _$setProp(_el$26, "wrapMode", "none");
                _$setProp(_el$28, "wrapMode", "none");
                _$insert(_el$28, () => model().composition.toolsText);
                _$effect(_p$ => {
                  var _v$4 = sysColor(),
                    _v$5 = base(),
                    _v$6 = chatColor(),
                    _v$7 = base(),
                    _v$8 = okColor(),
                    _v$9 = base();
                  _v$4 !== _p$.e && (_p$.e = _$setProp(_el$18, "fg", _v$4, _p$.e));
                  _v$5 !== _p$.t && (_p$.t = _$setProp(_el$20, "fg", _v$5, _p$.t));
                  _v$6 !== _p$.a && (_p$.a = _$setProp(_el$22, "fg", _v$6, _p$.a));
                  _v$7 !== _p$.o && (_p$.o = _$setProp(_el$24, "fg", _v$7, _p$.o));
                  _v$8 !== _p$.i && (_p$.i = _$setProp(_el$26, "fg", _v$8, _p$.i));
                  _v$9 !== _p$.n && (_p$.n = _$setProp(_el$28, "fg", _v$9, _p$.n));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined,
                  o: undefined,
                  i: undefined,
                  n: undefined
                });
                return _el$16;
              })(), _$createComponent(Show, {
                get when() {
                  return viewMode() === "default";
                },
                get children() {
                  return [(() => {
                    var _el$29 = _$createElement("box"),
                      _el$30 = _$createElement("text"),
                      _el$31 = _$createElement("text"),
                      _el$32 = _$createElement("b");
                    _$insertNode(_el$29, _el$30);
                    _$insertNode(_el$29, _el$31);
                    _$setProp(_el$29, "width", "100%");
                    _$setProp(_el$29, "flexDirection", "row");
                    _$setProp(_el$29, "alignItems", "center");
                    _$setProp(_el$29, "flexShrink", 0);
                    _$setProp(_el$30, "flexShrink", 1);
                    _$setProp(_el$30, "wrapMode", "none");
                    _$insert(_el$30, () => model().context.parts.join(" · "));
                    _$insertNode(_el$31, _el$32);
                    _$setProp(_el$31, "flexShrink", 0);
                    _$setProp(_el$31, "marginLeft", 2);
                    _$setProp(_el$31, "wrapMode", "none");
                    _$insert(_el$32, () => "● " + model().health.label);
                    _$effect(_p$ => {
                      var _v$0 = muted(),
                        _v$1 = tone(model().health.tone);
                      _v$0 !== _p$.e && (_p$.e = _$setProp(_el$30, "fg", _v$0, _p$.e));
                      _v$1 !== _p$.t && (_p$.t = _$setProp(_el$31, "fg", _v$1, _p$.t));
                      return _p$;
                    }, {
                      e: undefined,
                      t: undefined
                    });
                    return _el$29;
                  })(), (() => {
                    var _el$33 = _$createElement("box"),
                      _el$34 = _$createElement("text");
                    _$insertNode(_el$33, _el$34);
                    _$setProp(_el$33, "width", "100%");
                    _$setProp(_el$33, "flexDirection", "row");
                    _$setProp(_el$33, "alignItems", "center");
                    _$setProp(_el$33, "flexShrink", 0);
                    _$setProp(_el$34, "flexShrink", 1);
                    _$setProp(_el$34, "wrapMode", "none");
                    _$insert(_el$34, () => model().activity.parts.join(" · "));
                    _$effect(_$p => _$setProp(_el$34, "fg", tone(model().activity.tone), _$p));
                    return _el$33;
                  })()];
                }
              }), _$createComponent(Show, {
                get when() {
                  return viewMode() === "expanded";
                },
                get children() {
                  return [(() => {
                    var _el$35 = _$createElement("box"),
                      _el$36 = _$createElement("text");
                    _$insertNode(_el$35, _el$36);
                    _$setProp(_el$35, "width", "100%");
                    _$setProp(_el$35, "flexDirection", "row");
                    _$setProp(_el$35, "alignItems", "center");
                    _$setProp(_el$35, "flexShrink", 0);
                    _$setProp(_el$36, "flexShrink", 1);
                    _$setProp(_el$36, "wrapMode", "none");
                    _$insert(_el$36, () => model().context.detailParts.join(" · "));
                    _$effect(_$p => _$setProp(_el$36, "fg", muted(), _$p));
                    return _el$35;
                  })(), _$createComponent(For, {
                    get each() {
                      return model().detailLines;
                    },
                    children: row => (() => {
                      var _el$50 = _$createElement("box"),
                        _el$51 = _$createElement("text");
                      _$insertNode(_el$50, _el$51);
                      _$setProp(_el$50, "width", "100%");
                      _$setProp(_el$50, "flexDirection", "row");
                      _$setProp(_el$50, "alignItems", "center");
                      _$setProp(_el$50, "flexShrink", 0);
                      _$setProp(_el$51, "flexShrink", 1);
                      _$setProp(_el$51, "wrapMode", "none");
                      _$insert(_el$51, () => row.parts.join(" · "));
                      _$insert(_el$50, _$createComponent(Show, {
                        get when() {
                          return row.cachePolicy;
                        },
                        get children() {
                          return [(() => {
                            var _el$52 = _$createElement("text");
                            _$insertNode(_el$52, _$createTextNode(` · cache `));
                            _$setProp(_el$52, "flexShrink", 0);
                            _$setProp(_el$52, "wrapMode", "none");
                            _$effect(_$p => _$setProp(_el$52, "fg", muted(), _$p));
                            return _el$52;
                          })(), (() => {
                            var _el$54 = _$createElement("text"),
                              _el$55 = _$createElement("b");
                            _$insertNode(_el$54, _el$55);
                            _$setProp(_el$54, "flexShrink", 0);
                            _$setProp(_el$54, "wrapMode", "none");
                            _$insert(_el$55, () => row.cachePolicy);
                            _$effect(_$p => _$setProp(_el$54, "fg", tone(row.cacheTone ?? "muted"), _$p));
                            return _el$54;
                          })()];
                        }
                      }), null);
                      _$effect(_$p => _$setProp(_el$51, "fg", tone(row.tone), _$p));
                      return _el$50;
                    })()
                  })];
                }
              }), _$createComponent(Show, {
                get when() {
                  return stale();
                },
                get children() {
                  var _el$37 = _$createElement("text");
                  _$setProp(_el$37, "flexShrink", 1);
                  _$setProp(_el$37, "wrapMode", "none");
                  _$insert(_el$37, () => failed() ? "stats unavailable" : "stats stale");
                  _$effect(_$p => _$setProp(_el$37, "fg", theme?.text?.faint ?? muted(), _$p));
                  return _el$37;
                }
              })];
            }
          }));
          return _el$6;
        }
      });
    }
    let disposeSlot;
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
    return () => {
      if (typeof disposeSlot === "function") disposeSlot();
    };
  }
});
