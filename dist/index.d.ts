/** OpenCode V2 Promise server plugin. Stable public entrypoint. */
import { setupTrim } from "./plugin.ts";
export interface TrimPluginDefinition {
    id: string;
    setup: typeof setupTrim;
}
declare const plugin: TrimPluginDefinition;
export default plugin;
