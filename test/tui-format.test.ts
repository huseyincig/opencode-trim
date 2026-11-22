import test from "node:test"
import assert from "node:assert/strict"
import { fmtAge, fmtChars, fmtCount, fmtPercent, isAscii, splitBar } from "../src/tui-format.ts"

test("unknown values render --", () => {
  for (const f of [fmtCount, fmtChars, fmtPercent, fmtAge]) {
    for (const v of [null, undefined, NaN, Infinity, "x"]) assert.equal(f(v), "--")
  }
})

test("zero stays 0", () => {
  assert.equal(fmtCount(0), "0")
  assert.equal(fmtChars(0), "0")
  assert.equal(fmtPercent(0), "0%")
  assert.equal(fmtAge(0), "0s")
})

test("k/M rounding and negatives", () => {
  assert.equal(fmtCount(999), "999")
  assert.equal(fmtCount(1500), "1.5k")
  assert.equal(fmtCount(42000), "42k")
  assert.equal(fmtCount(999600), "1M")
  assert.equal(fmtCount(2_500_000), "2.5M")
  assert.equal(fmtCount(-42000), "-42k")
})

test("percent shows unclamped ratio, bar clamps", () => {
  assert.equal(fmtPercent(0.684), "68%")
  assert.equal(fmtPercent(1.2), "120%")
  assert.equal(splitBar(1.2).text, "##########")
  assert.equal(splitBar(-1).text, "----------")
  assert.equal(splitBar(0.68).text, "#######---")
  assert.equal(splitBar(0.5, 4).text, "##--")
  assert.equal(splitBar(null).text, "----------")
  assert.equal(splitBar(0.3).text.length, 10)
})

test("age units", () => {
  assert.equal(fmtAge(5000), "5s")
  assert.equal(fmtAge(120000), "2m")
  assert.equal(fmtAge(7200000), "2h")
  assert.equal(fmtAge(172800000), "2d")
  assert.equal(fmtAge(-5), "0s")
})

test("ascii", () => {
  assert.ok(isAscii("ctx [##--] 68%"))
  assert.ok(!isAscii("68% \u2192"))
  assert.ok(!isAscii(null))
})
