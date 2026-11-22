import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
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
import { buildCollapsedRows, buildHeader, buildSections, compactionHistory, isStale, nativeContextTokens, normalizeEventSessionID, STORAGE_KEY, TRIM_VERSION } from "./tui-model.js";
const DEBOUNCE_MS = 150;
const POLL_MS = 2000;
const MAX_HIDDEN_RETRIES = 3;
const REFRESH_EVENTS = ["session.compaction.started", "session.compaction.ended", "session.compaction.failed", "session.step.ended"];
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
          expanded: false
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
    const isExpanded = () => stored?.expanded === true;
    const toggle = () => {
      try {
        void Promise.resolve(updateStored(draft => {
          draft.expanded = !draft.expanded;
        })).catch(() => {});
      } catch {}
    };
    const theme = context.theme;
    const base = () => theme?.text?.base ?? "white";
    const muted = () => theme?.text?.muted ?? base();
    const tone = name => name === "error" ? theme?.status?.error?.base ?? theme?.text?.feedback?.error?.base ?? base() : name === "warning" ? theme?.status?.warning?.base ?? theme?.text?.feedback?.warning?.base ?? base() : name === "success" ? theme?.status?.success?.base ?? theme?.text?.accent?.base ?? base() : name === "muted" ? muted() : name === "accent" ? theme?.text?.accent?.base ?? theme?.text?.accent ?? theme?.status?.success?.base ?? base() : base();
    function TrimSidebar(props) {
      // Hidden until the first successful stats RPC snapshot (the server's tui.enabled is the opt-in).
      // Kept across session switches so the sidebar never unmounts/flickers when changing sessions.
      const [visible, setVisible] = createSignal(false);
      const [snapshot, setSnapshot] = createSignal(null);
      const [failed, setFailed] = createSignal(false);
      const [nativeTokens, setNativeTokens] = createSignal(null);
      const [nativeLimit, setNativeLimit] = createSignal(null);
      const [history, setHistory] = createSignal(null);
      const [now, setNow] = createSignal(Date.now());
      const running = () => !!props.sessionID && context.data?.session?.status?.(props.sessionID) === "running";
      createEffect(on(() => props.sessionID, sessionID => {
        setSnapshot(null);
        setFailed(false);
        setNativeTokens(null);
        setNativeLimit(null);
        setHistory(null);
        if (!sessionID) return;
        let seq = 0;
        let disposed = false;
        let timer;
        let messagesSynced = false;
        let modelsSynced = false;
        let hiddenRetries = 0;
        let hiddenStopped = false;
        const resolveLimit = async id => {
          const session = await Promise.resolve(context.data?.session?.get?.(id));
          const ref = session?.model;
          if (!ref) return null;
          const models = context.data?.location?.model;
          if (!models || typeof models.list !== "function") return null;
          const find = list => Array.isArray(list) ? list.find(m => m?.providerID === ref.providerID && (m?.id === ref.id || m?.modelID === ref.id)) : undefined;
          let found = find(await Promise.resolve(models.list(context.location)));
          if (!found && !modelsSynced && typeof models.sync === "function") {
            modelsSynced = true;
            await Promise.resolve(models.sync(context.location));
            found = find(await Promise.resolve(models.list(context.location)));
          }
          const v = found?.limit?.context;
          return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
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
              }
            }
          } catch {
            if (!disposed && mine === seq) {
              setNativeTokens(null);
              setHistory(null);
            }
          }
          try {
            const limit = await resolveLimit(sessionID);
            if (!disposed && mine === seq) setNativeLimit(limit);
          } catch {
            if (!disposed && mine === seq) setNativeLimit(null);
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
      const collapsedRows = createMemo(() => buildCollapsedRows(snapshot(), {
        nativeTokens: nativeTokens(),
        nativeLimitTokens: nativeLimit()
      }));
      const sections = createMemo(() => buildSections(snapshot(), now(), {
        nativeTokens: nativeTokens(),
        nativeLimitTokens: nativeLimit(),
        compactionHistory: history()
      }));
      const header = createMemo(() => buildHeader(snapshot(), {
        expanded: isExpanded(),
        stale: stale(),
        nativeTokens: nativeTokens(),
        nativeLimitTokens: nativeLimit()
      }));
      return _$createComponent(Show, {
        get when() {
          return visible();
        },
        get children() {
          var _el$5 = _$createElement("box"),
            _el$6 = _$createElement("box"),
            _el$7 = _$createElement("box"),
            _el$8 = _$createElement("text"),
            _el$9 = _$createElement("text"),
            _el$0 = _$createElement("b"),
            _el$10 = _$createElement("box"),
            _el$11 = _$createElement("text");
          _$insertNode(_el$5, _el$6);
          _$setProp(_el$5, "flexDirection", "column");
          _$setProp(_el$5, "flexShrink", 0);
          _$setProp(_el$5, "width", "100%");
          _$setProp(_el$5, "gap", 0);
          _$insertNode(_el$6, _el$7);
          _$insertNode(_el$6, _el$10);
          _$setProp(_el$6, "width", "100%");
          _$setProp(_el$6, "flexDirection", "row");
          _$setProp(_el$6, "justifyContent", "space-between");
          _$setProp(_el$6, "alignItems", "center");
          _$setProp(_el$6, "flexShrink", 0);
          _$setProp(_el$6, "onMouseUp", toggle);
          _$insertNode(_el$7, _el$8);
          _$insertNode(_el$7, _el$9);
          _$setProp(_el$7, "flexDirection", "row");
          _$setProp(_el$7, "alignItems", "center");
          _$setProp(_el$8, "wrapMode", "none");
          _$insert(_el$8, () => isExpanded() ? "▼ " : "▶ ");
          _$insertNode(_el$9, _el$0);
          _$setProp(_el$9, "wrapMode", "none");
          _$insertNode(_el$0, _$createTextNode(`Trim`));
          _$insertNode(_el$10, _el$11);
          _$setProp(_el$10, "flexDirection", "row");
          _$setProp(_el$10, "alignItems", "center");
          _$setProp(_el$11, "wrapMode", "none");
          _$insert(_el$11, "v" + TRIM_VERSION);
          _$insert(_el$10, _$createComponent(Show, {
            get when() {
              return header().marker;
            },
            get children() {
              var _el$12 = _$createElement("text");
              _$setProp(_el$12, "wrapMode", "none");
              _$insert(_el$12, () => " " + header().marker);
              _$effect(_$p => _$setProp(_el$12, "fg", tone("warning"), _$p));
              return _el$12;
            }
          }), null);
          _$insert(_el$5, _$createComponent(Show, {
            get when() {
              return !isExpanded();
            },
            get children() {
              return _$createComponent(For, {
                get each() {
                  return collapsedRows();
                },
                children: row => _$createComponent(StatRow, {
                  get label() {
                    return row.label;
                  },
                  get value() {
                    return row.value;
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
          _$insert(_el$5, _$createComponent(Show, {
            get when() {
              return isExpanded();
            },
            get children() {
              return [_$createComponent(For, {
                get each() {
                  return sections();
                },
                children: section => (() => {
                  var _el$14 = _$createElement("box");
                  _$setProp(_el$14, "flexDirection", "column");
                  _$setProp(_el$14, "flexShrink", 0);
                  _$setProp(_el$14, "width", "100%");
                  _$insert(_el$14, (() => {
                    var _c$ = _$memo(() => !!section.title);
                    return () => _c$() ? (() => {
                      var _el$15 = _$createElement("text");
                      _$setProp(_el$15, "attributes", 1);
                      _$setProp(_el$15, "flexShrink", 1);
                      _$setProp(_el$15, "wrapMode", "none");
                      _$insert(_el$15, () => section.title);
                      _$effect(_$p => _$setProp(_el$15, "fg", muted(), _$p));
                      return _el$15;
                    })() : null;
                  })(), null);
                  _$insert(_el$14, _$createComponent(For, {
                    get each() {
                      return section.rows;
                    },
                    children: row => _$createComponent(StatRow, {
                      get label() {
                        return row.label;
                      },
                      get value() {
                        return row.value;
                      },
                      get labelColor() {
                        return muted();
                      },
                      get valueColor() {
                        return tone(row.tone);
                      }
                    })
                  }), null);
                  return _el$14;
                })()
              }), _$createComponent(Show, {
                get when() {
                  return stale();
                },
                get children() {
                  var _el$13 = _$createElement("text");
                  _$setProp(_el$13, "flexShrink", 1);
                  _$setProp(_el$13, "wrapMode", "none");
                  _$insert(_el$13, () => failed() ? "stats unavailable" : "stats stale");
                  _$effect(_$p => _$setProp(_el$13, "fg", theme?.text?.faint ?? muted(), _$p));
                  return _el$13;
                }
              })];
            }
          }), null);
          _$effect(_p$ => {
            var _v$3 = muted(),
              _v$4 = base(),
              _v$5 = muted();
            _v$3 !== _p$.e && (_p$.e = _$setProp(_el$8, "fg", _v$3, _p$.e));
            _v$4 !== _p$.t && (_p$.t = _$setProp(_el$9, "fg", _v$4, _p$.t));
            _v$5 !== _p$.a && (_p$.a = _$setProp(_el$11, "fg", _v$5, _p$.a));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined
          });
          return _el$5;
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
