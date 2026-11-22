// Adaptive Trim TUI entrypoint: host runtime first, standalone Node fallback.
let hostRuntime = false;
try {
  await import("opentui:runtime-module:%40opentui%2Fsolid");
  hostRuntime = true;
} catch {
  hostRuntime = false;
}
let implementation;
if (hostRuntime) {
  implementation = await import("./tui-runtime.js");
} else {
  try {
    implementation = await import("./tui-standalone.js");
  } catch {
    implementation = { default: { id: "opencode-trim.tui", setup: async () => undefined } };
  }
}
export default implementation.default;
export const setup = implementation.default.setup;
