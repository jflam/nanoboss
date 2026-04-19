import type { TuiExtension } from "@nanoboss/tui-extension-sdk";
import type { LoadableTuiExtensionRegistry } from "./loadable-registry.ts";

/**
 * Built-in TUI extensions compiled into Nanoboss itself.
 *
 * Reserved placeholder — no builtin extensions exist today. As the
 * primitives plan lands and core panel renderers / chrome contributions
 * are migrated to the extension surface, they will be added here.
 */
const BUILTIN_EXTENSIONS: readonly TuiExtension[] = [];

export function loadBuiltinTuiExtensions(registry: LoadableTuiExtensionRegistry): void {
  for (const extension of BUILTIN_EXTENSIONS) {
    registry.registerBuiltinExtension(extension);
  }
}
