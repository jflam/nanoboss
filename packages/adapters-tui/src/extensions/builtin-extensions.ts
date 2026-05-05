import type { TuiExtension } from "@nanoboss/tui-extension-sdk";

import { createNbCardV1Renderer } from "../core/core-panels.ts";

interface BuiltinTuiExtensionRegistry {
  registerBuiltinExtension(extension: TuiExtension): void;
}

const nbCoreCardsExtension: TuiExtension = {
  metadata: {
    name: "nanoboss-core-ui",
    version: "1.0.0",
    description: "Built-in core UI renderers (nb/card@1 panels)",
    provides: { panelRenderers: ["nb/card@1"] },
  },
  activate(ctx) {
    ctx.registerPanelRenderer(createNbCardV1Renderer());
  },
};

const BUILTIN_TUI_EXTENSIONS: readonly TuiExtension[] = [nbCoreCardsExtension];

export function registerBuiltinTuiExtensions(registry: BuiltinTuiExtensionRegistry): void {
  for (const extension of BUILTIN_TUI_EXTENSIONS) {
    registry.registerBuiltinExtension(extension);
  }
}
