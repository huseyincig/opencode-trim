import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
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
const COLLAPSED_BAR_WIDTH = 12;
const EXPANDED_BAR_WIDTH = 24;
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
function StatRow(props) {
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text"),
      _el$3 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "justifyContent", "space-between");
    _$setProp(_el$2, "flexShrink", 0);
    _$setProp(_el$2, "wrapMode", "none");
    _$insert(_el$2, () => props.label);
    _$setProp(_el$3, "flexShrink", 1);
    _$setProp(_el$3, "marginLeft", 1);
    _$setProp(_el$3, "wrapMode", "none");
    _$insert(_el$3, () => props.value);
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
    var _el$4 = _$createElement("box");
    _$setProp(_el$4, "flexDirection", "row");
    _$setProp(_el$4, "flexShrink", 1);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return s().sys > 0;
      },
      get children() {
        var _el$5 = _$createElement("text");
        _$setProp(_el$5, "wrapMode", "none");
        _$insert(_el$5, () => "█".repeat(s().sys));
        _$effect(_$p => _$setProp(_el$5, "fg", props.sysColor, _$p));
        return _el$5;
      }
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return s().chat > 0;
      },
      get children() {
        var _el$6 = _$createElement("text");
        _$setProp(_el$6, "wrapMode", "none");
        _$insert(_el$6, () => "█".repeat(s().chat));
        _$effect(_$p => _$setProp(_el$6, "fg", props.chatColor, _$p));
        return _el$6;
      }
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return s().tools > 0;
      },
      get children() {
        var _el$7 = _$createElement("text");
        _$setProp(_el$7, "wrapMode", "none");
        _$insert(_el$7, () => "█".repeat(s().tools));
        _$effect(_$p => _$setProp(_el$7, "fg", props.toolsColor, _$p));
        return _el$7;
      }
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return s().toolsWarn > 0;
      },
      get children() {
        var _el$8 = _$createElement("text");
        _$setProp(_el$8, "wrapMode", "none");
        _$insert(_el$8, () => "█".repeat(s().toolsWarn));
        _$effect(_$p => _$setProp(_el$8, "fg", props.warnColor, _$p));
        return _el$8;
      }
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
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
    return _el$4;
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
      const toolsBarColor = () => model().health.state === "critical" ? errColor() : okColor();
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
                var _el$36 = _$createElement("box"),
                  _el$37 = _$createElement("box"),
                  _el$38 = _$createElement("text"),
                  _el$40 = _$createElement("text"),
                  _el$41 = _$createElement("b"),
                  _el$43 = _$createElement("box"),
                  _el$44 = _$createElement("box"),
                  _el$45 = _$createElement("text"),
                  _el$46 = _$createElement("b");
                _$insertNode(_el$36, _el$37);
                _$insertNode(_el$36, _el$43);
                _$insertNode(_el$36, _el$44);
                _$setProp(_el$36, "width", "100%");
                _$setProp(_el$36, "flexDirection", "row");
                _$setProp(_el$36, "justifyContent", "space-between");
                _$setProp(_el$36, "alignItems", "center");
                _$setProp(_el$36, "flexShrink", 0);
                _$setProp(_el$36, "onMouseUp", toggle);
                _$insertNode(_el$37, _el$38);
                _$insertNode(_el$37, _el$40);
                _$setProp(_el$37, "flexDirection", "row");
                _$setProp(_el$37, "alignItems", "center");
                _$setProp(_el$37, "flexShrink", 0);
                _$insertNode(_el$38, _$createTextNode(`▶ `));
                _$setProp(_el$38, "wrapMode", "none");
                _$insertNode(_el$40, _el$41);
                _$setProp(_el$40, "wrapMode", "none");
                _$insertNode(_el$41, _$createTextNode(`Trim`));
                _$setProp(_el$43, "flexDirection", "row");
                _$setProp(_el$43, "alignItems", "center");
                _$setProp(_el$43, "flexShrink", 1);
                _$setProp(_el$43, "marginLeft", 1);
                _$insert(_el$43, _$createComponent(SegmentedBar, {
                  get segments() {
                    return collapsedSegments();
                  },
                  get health() {
                    return model().health.state;
                  },
                  get sysColor() {
                    return sysColor();
                  },
                  get chatColor() {
                    return chatColor();
                  },
                  get toolsColor() {
                    return toolsBarColor();
                  },
                  get warnColor() {
                    return warnColor();
                  },
                  get emptyColor() {
                    return faint();
                  }
                }));
                _$insertNode(_el$44, _el$45);
                _$setProp(_el$44, "flexDirection", "row");
                _$setProp(_el$44, "alignItems", "center");
                _$setProp(_el$44, "flexShrink", 0);
                _$setProp(_el$44, "marginLeft", 1);
                _$insertNode(_el$45, _el$46);
                _$setProp(_el$45, "wrapMode", "none");
                _$insert(_el$46, () => model().context.percentText);
                _$insert(_el$44, _$createComponent(Show, {
                  get when() {
                    return model().sessionAge;
                  },
                  get children() {
                    var _el$47 = _$createElement("text");
                    _$setProp(_el$47, "wrapMode", "none");
                    _$insert(_el$47, () => " " + model().sessionAge);
                    _$effect(_$p => _$setProp(_el$47, "fg", muted(), _$p));
                    return _el$47;
                  }
                }), null);
                _$insert(_el$44, _$createComponent(Show, {
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
                  var _v$10 = muted(),
                    _v$11 = base(),
                    _v$12 = tone(model().health.tone);
                  _v$10 !== _p$.e && (_p$.e = _$setProp(_el$38, "fg", _v$10, _p$.e));
                  _v$11 !== _p$.t && (_p$.t = _$setProp(_el$40, "fg", _v$11, _p$.t));
                  _v$12 !== _p$.a && (_p$.a = _$setProp(_el$45, "fg", _v$12, _p$.a));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined
                });
                return _el$36;
              })();
            },
            get children() {
              return [(() => {
                var _el$1 = _$createElement("box"),
                  _el$10 = _$createElement("box"),
                  _el$11 = _$createElement("text"),
                  _el$13 = _$createElement("text"),
                  _el$14 = _$createElement("b"),
                  _el$16 = _$createElement("box"),
                  _el$17 = _$createElement("text");
                _$insertNode(_el$1, _el$10);
                _$insertNode(_el$1, _el$16);
                _$setProp(_el$1, "width", "100%");
                _$setProp(_el$1, "flexDirection", "row");
                _$setProp(_el$1, "justifyContent", "space-between");
                _$setProp(_el$1, "alignItems", "center");
                _$setProp(_el$1, "flexShrink", 0);
                _$setProp(_el$1, "onMouseUp", toggle);
                _$insertNode(_el$10, _el$11);
                _$insertNode(_el$10, _el$13);
                _$setProp(_el$10, "flexDirection", "row");
                _$setProp(_el$10, "alignItems", "center");
                _$insertNode(_el$11, _$createTextNode(`▼ `));
                _$setProp(_el$11, "wrapMode", "none");
                _$insertNode(_el$13, _el$14);
                _$setProp(_el$13, "wrapMode", "none");
                _$insertNode(_el$14, _$createTextNode(`Trim`));
                _$insertNode(_el$16, _el$17);
                _$setProp(_el$16, "flexDirection", "row");
                _$setProp(_el$16, "alignItems", "center");
                _$setProp(_el$17, "wrapMode", "none");
                _$insert(_el$17, "v" + TRIM_VERSION);
                _$insert(_el$16, _$createComponent(Show, {
                  get when() {
                    return header().marker;
                  },
                  get children() {
                    var _el$18 = _$createElement("text");
                    _$setProp(_el$18, "wrapMode", "none");
                    _$insert(_el$18, () => " " + header().marker);
                    _$effect(_$p => _$setProp(_el$18, "fg", tone("warning"), _$p));
                    return _el$18;
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$3 = muted(),
                    _v$4 = base(),
                    _v$5 = muted();
                  _v$3 !== _p$.e && (_p$.e = _$setProp(_el$11, "fg", _v$3, _p$.e));
                  _v$4 !== _p$.t && (_p$.t = _$setProp(_el$13, "fg", _v$4, _p$.t));
                  _v$5 !== _p$.a && (_p$.a = _$setProp(_el$17, "fg", _v$5, _p$.a));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined
                });
                return _el$1;
              })(), (() => {
                var _el$19 = _$createElement("box"),
                  _el$20 = _$createElement("text"),
                  _el$21 = _$createElement("b");
                _$insertNode(_el$19, _el$20);
                _$setProp(_el$19, "width", "100%");
                _$setProp(_el$19, "flexDirection", "row");
                _$setProp(_el$19, "justifyContent", "space-between");
                _$setProp(_el$19, "alignItems", "center");
                _$setProp(_el$19, "flexShrink", 0);
                _$insert(_el$19, _$createComponent(SegmentedBar, {
                  get segments() {
                    return expandedSegments();
                  },
                  get health() {
                    return model().health.state;
                  },
                  get sysColor() {
                    return sysColor();
                  },
                  get chatColor() {
                    return chatColor();
                  },
                  get toolsColor() {
                    return toolsBarColor();
                  },
                  get warnColor() {
                    return warnColor();
                  },
                  get emptyColor() {
                    return faint();
                  }
                }), _el$20);
                _$insertNode(_el$20, _el$21);
                _$setProp(_el$20, "flexShrink", 0);
                _$setProp(_el$20, "marginLeft", 1);
                _$setProp(_el$20, "wrapMode", "none");
                _$insert(_el$21, () => model().context.percentText);
                _$effect(_$p => _$setProp(_el$20, "fg", tone(model().health.tone), _$p));
                return _el$19;
              })(), (() => {
                var _el$22 = _$createElement("box"),
                  _el$23 = _$createElement("box"),
                  _el$24 = _$createElement("text"),
                  _el$26 = _$createElement("text"),
                  _el$28 = _$createElement("text"),
                  _el$30 = _$createElement("text");
                _$insertNode(_el$22, _el$23);
                _$insertNode(_el$22, _el$30);
                _$setProp(_el$22, "width", "100%");
                _$setProp(_el$22, "flexDirection", "row");
                _$setProp(_el$22, "justifyContent", "space-between");
                _$setProp(_el$22, "alignItems", "center");
                _$setProp(_el$22, "flexShrink", 0);
                _$insertNode(_el$23, _el$24);
                _$insertNode(_el$23, _el$26);
                _$insertNode(_el$23, _el$28);
                _$setProp(_el$23, "flexDirection", "row");
                _$setProp(_el$23, "alignItems", "center");
                _$setProp(_el$23, "flexShrink", 0);
                _$insertNode(_el$24, _$createTextNode(`sys`));
                _$setProp(_el$24, "wrapMode", "none");
                _$insertNode(_el$26, _$createTextNode(`  chat`));
                _$setProp(_el$26, "wrapMode", "none");
                _$insertNode(_el$28, _$createTextNode(`  tools`));
                _$setProp(_el$28, "wrapMode", "none");
                _$setProp(_el$30, "flexShrink", 1);
                _$setProp(_el$30, "marginLeft", 1);
                _$setProp(_el$30, "wrapMode", "none");
                _$insert(_el$30, () => model().context.pairText);
                _$effect(_p$ => {
                  var _v$6 = sysColor(),
                    _v$7 = chatColor(),
                    _v$8 = okColor(),
                    _v$9 = base();
                  _v$6 !== _p$.e && (_p$.e = _$setProp(_el$24, "fg", _v$6, _p$.e));
                  _v$7 !== _p$.t && (_p$.t = _$setProp(_el$26, "fg", _v$7, _p$.t));
                  _v$8 !== _p$.a && (_p$.a = _$setProp(_el$28, "fg", _v$8, _p$.a));
                  _v$9 !== _p$.o && (_p$.o = _$setProp(_el$30, "fg", _v$9, _p$.o));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined,
                  o: undefined
                });
                return _el$22;
              })(), _$createComponent(Show, {
                get when() {
                  return viewMode() === "default";
                },
                get children() {
                  var _el$31 = _$createElement("box"),
                    _el$32 = _$createElement("box"),
                    _el$33 = _$createElement("text"),
                    _el$34 = _$createElement("text");
                  _$insertNode(_el$31, _el$32);
                  _$insertNode(_el$31, _el$34);
                  _$setProp(_el$31, "width", "100%");
                  _$setProp(_el$31, "flexDirection", "row");
                  _$setProp(_el$31, "justifyContent", "space-between");
                  _$setProp(_el$31, "alignItems", "center");
                  _$setProp(_el$31, "flexShrink", 0);
                  _$insertNode(_el$32, _el$33);
                  _$setProp(_el$32, "flexDirection", "row");
                  _$setProp(_el$32, "alignItems", "center");
                  _$setProp(_el$32, "flexShrink", 0);
                  _$setProp(_el$33, "wrapMode", "none");
                  _$insert(_el$33, () => "● " + model().health.label);
                  _$setProp(_el$34, "flexShrink", 1);
                  _$setProp(_el$34, "marginLeft", 1);
                  _$setProp(_el$34, "wrapMode", "none");
                  _$insert(_el$34, () => model().statusRight.parts.join(" · "));
                  _$effect(_p$ => {
                    var _v$0 = tone(model().health.tone),
                      _v$1 = tone(model().statusRight.tone);
                    _v$0 !== _p$.e && (_p$.e = _$setProp(_el$33, "fg", _v$0, _p$.e));
                    _v$1 !== _p$.t && (_p$.t = _$setProp(_el$34, "fg", _v$1, _p$.t));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined
                  });
                  return _el$31;
                }
              }), _$createComponent(Show, {
                get when() {
                  return viewMode() === "expanded";
                },
                get children() {
                  return _$createComponent(For, {
                    get each() {
                      return model().details;
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
              }), _$createComponent(Show, {
                get when() {
                  return stale();
                },
                get children() {
                  var _el$35 = _$createElement("text");
                  _$setProp(_el$35, "flexShrink", 1);
                  _$setProp(_el$35, "wrapMode", "none");
                  _$insert(_el$35, () => failed() ? "stats unavailable" : "stats stale");
                  _$effect(_$p => _$setProp(_el$35, "fg", theme?.text?.faint ?? muted(), _$p));
                  return _el$35;
                }
              })];
            }
          }));
          return _el$0;
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
