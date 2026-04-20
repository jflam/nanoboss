import type { TuiExtension } from "@nanoboss/tui-extension-sdk";
import type { LoadableTuiExtensionRegistry } from "./loadable-registry.ts";

/**
 * Built-in TUI extensions compiled into Nanoboss itself.
 *
 * The `nanoboss-core-ui` extension owns the `nb/card@1` panel renderer. The
 * renderer implementation lives in `@nanoboss/adapters-tui/core-panels.ts`;
 * moving it through the extension activation path (rather than registering
 * it at core module-import time) guarantees every panel renderer in the
 * system — first-party or third-party — flows through the same precedence
 * rules (repo > profile > builtin) and shadow-warning diagnostics.
 *
 * The top-level type-only import avoids pulling `adapters-tui` into the
 * catalog's module graph at eval time; the actual renderer factory is
 * imported dynamically inside `activate()`, which runs long after both
 * packages have finished evaluating.
 */
const nbCoreCardsExtension: TuiExtension = {
  metadata: {
    name: "nanoboss-core-ui",
    version: "1.0.0",
    description: "Built-in core UI renderers (nb/card@1 panels)",
    provides: { panelRenderers: ["nb/card@1"] },
  },
  async activate(ctx) {
    const { createNbCardV1Renderer } = await import("@nanoboss/adapters-tui");
    ctx.registerPanelRenderer(createNbCardV1Renderer());
  },
};

const BUILTIN_EXTENSIONS: readonly TuiExtension[] = [nbCoreCardsExtension];

export function loadBuiltinTuiExtensions(registry: LoadableTuiExtensionRegistry): void {
  for (const extension of BUILTIN_EXTENSIONS) {
    registry.registerBuiltinExtension(extension);
  }
}
