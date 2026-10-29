import type { BuiltinPlugin } from "../plugins";
import { daily } from "./daily";
import { webhooksPlugin } from "./webhooks";

/**
 * Sink's own extras, written against the same plugin API as anyone's. Diagrams and math are client-only
 * (web/src/plugins/); listing them here lets the server tell clients they're on, and lets owners turn them off
 * with SINK_PLUGINS_DISABLED.
 */
export const builtinPlugins = (): BuiltinPlugin[] => [
  { id: "diagrams", name: "Diagrams", description: "Renders ```mermaid code blocks as diagrams.", bundledClient: true },
  { id: "math", name: "Math", description: "Renders ```math code blocks with KaTeX.", bundledClient: true },
  daily,
  webhooksPlugin(),
];
