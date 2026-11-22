/** OpenCode V2 Promise server plugin. Stable public entrypoint. */
import { setupTrim } from "./plugin.js";
const plugin = {
    id: "opencode-trim",
    setup: setupTrim,
};
export default plugin;
