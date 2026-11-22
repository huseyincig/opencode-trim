/**
 * Emit Solid Universal TUI variants from src/tui.tsx into dist/.
 * Runtime shares OpenCode's virtual Solid renderer; standalone supports Node tests.
 */
import { transformSync } from "@babel/core";
import babelPresetSolid from "babel-preset-solid";
import babelPresetTypescript from "@babel/preset-typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root: string = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath: string = path.join(root, "src", "tui.tsx");
const dist: string = path.join(root, "dist");
const source: string = readFileSync(sourcePath, "utf8").replace(/from\s+(["'])(\.\.?\/[^"']+?)\.ts\1/g, 'from $1$2.js$1');

function compile(moduleName: string): string {
  const result = transformSync(source, {
    filename: sourcePath,
    babelrc: false,
    configFile: false,
    presets: [
      [babelPresetSolid, { moduleName, generate: "universal" }],
      [babelPresetTypescript, { isTSX: true, allExtensions: true }],
    ],
  });
  if (!result?.code) throw new Error("Solid Universal TUI compilation failed");
  return result.code;
}

const runtime: string = compile("opentui:runtime-module:%40opentui%2Fsolid")
  .replace(/from (["'])solid-js\1/g, 'from "opentui:runtime-module:solid-js"')
  .replace(/from (["'])@opentui\/core\1/g, 'from "opentui:runtime-module:%40opentui%2Fcore"')
  .replace(/from (["'])@opencode\/plugin\/tui\1/g, 'from "opentui:runtime-module:%40opencode%2Fplugin%2Ftui"');
const standalone: string = compile("@opentui/solid");

writeFileSync(path.join(dist, "tui-runtime.js"), runtime + "\n");
writeFileSync(path.join(dist, "tui-standalone.js"), standalone + "\n");
writeFileSync(
  path.join(dist, "tui.js"),
  [
    "// Adaptive Trim TUI entrypoint: host runtime first, standalone Node fallback.",
    "let hostRuntime = false;",
    "try {",
    '  await import("opentui:runtime-module:%40opentui%2Fsolid");',
    "  hostRuntime = true;",
    "} catch {",
    "  hostRuntime = false;",
    "}",
    "let implementation;",
    "if (hostRuntime) {",
    '  implementation = await import("./tui-runtime.js");',
    "} else {",
    "  try {",
    '    implementation = await import("./tui-standalone.js");',
    "  } catch {",
    '    implementation = { default: { id: "opencode-trim.tui", setup: async () => undefined } };',
    "  }",
    "}",
    "export default implementation.default;",
    "export const setup = implementation.default.setup;",
    "",
  ].join("\n"),
);
