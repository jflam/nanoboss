// End-to-end fixture TUI extension used by
// packages/adapters-tui/tests/tui-fixture-extension.test.ts. It exercises
// the full discover → compile → import → activate pipeline against the real
// on-disk loader (no Bun.build mocks). A grep-able top-level `metadata`
// export matches the static-discovery contract the catalog relies on.
import type { TuiExtension, TuiExtensionMetadata } from "@nanoboss/tui-extension-sdk";

export const metadata: TuiExtensionMetadata = {
  name: "acme-hello",
  version: "1.0.0",
  description: "End-to-end fixture TUI extension exercising keybinding and chrome registration",
  provides: {
    bindings: ["greet"],
    chromeContributions: ["badge"],
  },
};

const SEQUENCE = "\u0001acme-hello-greet\u0001";

const extension: TuiExtension = {
  metadata,
  activate(ctx) {
    // Local id "greet" must be namespaced by the catalog to
    // "acme-hello/greet" before it lands in the key-binding registry.
    ctx.registerKeyBinding({
      id: "greet",
      category: "custom",
      label: "acme hello greet",
      match: (data) => data === SEQUENCE,
      run: () => ({ consume: true }),
    });

    // Local id "badge" must be namespaced to "acme-hello/badge" in the
    // chrome-contribution registry's "footer" slot.
    ctx.registerChromeContribution({
      id: "badge",
      slot: "footer",
      render: () => ({ acme: true } as unknown as never),
    });

    ctx.log.info("acme-hello activated");
  },
};

export default extension;
