/** OpenCode V2 Promise server plugin. Stable public entrypoint. */
import { setupTrim } from "./src/plugin.ts";

export interface TrimPluginDefinition {
  id: string;
  setup: typeof setupTrim;
}

const plugin: TrimPluginDefinition = {
  id: "opencode-trim",
  setup: setupTrim,
};

export default plugin;
