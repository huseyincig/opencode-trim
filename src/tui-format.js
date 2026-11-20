// Pure ASCII formatting helpers for the optional TUI sidebar.
const NONE = "--"

function num(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

function scaled(n) {
  const sign = n < 0 ? "-" : ""
  const abs = Math.abs(n)
  if (abs < 1000) return sign + String(Math.round(abs))
  const trim = (v, digits) => String(Number(v.toFixed(digits)))
  if (abs < 1e6) {
    const k = abs / 1000
    const r = k < 10 ? Number(k.toFixed(1)) : Math.round(k)
    if (r < 1000) return sign + trim(r, 1) + "k"
  }
  const m = abs / 1e6
  const r = m < 10 ? trim(m, 1) : String(Math.round(m))
  return sign + r + "M"
}

export function fmtCount(value) {
  const n = num(value)
  return n === null ? NONE : scaled(n)
}

export function fmtChars(value) {
  return fmtCount(value)
}

// Displays the unclamped ratio (0..1) as a whole percent.
export function fmtPercent(ratio) {
  const n = num(ratio)
  return n === null ? NONE : String(Math.round(n * 100)) + "%"
}

export function fmtAge(ms) {
  const n = num(ms)
  if (n === null) return NONE
  const s = Math.floor(Math.max(0, n) / 1000)
  if (s < 60) return s + "s"
  const m = Math.floor(s / 60)
  if (m < 60) return m + "m"
  const h = Math.floor(m / 60)
  if (h < 24) return h + "h"
  return Math.floor(h / 24) + "d"
}

// Fixed-width bar; ratio clamped to 0..1 for drawing only. Unknown => all dashes.
export function splitBar(ratio, width = 10) {
  const w = Number.isInteger(width) && width > 0 ? width : 10
  const n = num(ratio)
  if (n === null) return { filled: "", empty: "-".repeat(w), text: "-".repeat(w) }
  const clamped = Math.min(1, Math.max(0, n))
  const f = Math.round(clamped * w)
  const filled = "#".repeat(f)
  const empty = "-".repeat(w - f)
  return { filled, empty, text: filled + empty }
}

export function isAscii(text) {
  return typeof text === "string" && /^[\x20-\x7e]*$/.test(text)
}
