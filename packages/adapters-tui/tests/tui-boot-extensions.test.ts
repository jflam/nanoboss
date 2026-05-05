import { describe, expect, test } from "bun:test";

import type {
  BindingResult,
  KeyBindingController,
  KeyBindingEditor,
  TuiExtension,
  TuiExtensionContext,
} from "@nanoboss/tui-extension-sdk";
import { TuiExtensionRegistry } from "@nanoboss/tui-extension-catalog";
import type { TypeDescriptor } from "@nanoboss/procedure-sdk";

import {
  bootExtensions,
  createInitialUiState,
  createNanobossTuiTheme,
} from "@nanoboss/adapters-tui";
import {
  dispatchKeyBinding,
  listKeyBindings,
  type BindingCtx,
  type KeyBindingAppHooks,
} from "../src/core/bindings.ts";
import {
  getChromeContributions,
} from "../src/core/chrome.ts";
import {
  getPanelRenderer,
  type PanelRenderer,
} from "../src/core/panel-renderers.ts";

function makeBindingCtx(overrides: Partial<BindingCtx> = {}): BindingCtx {
  const controller: KeyBindingController = {
    toggleToolOutput() {},
    toggleToolCardsHidden() {},
    toggleSimplify2AutoApprove() {},
        showLocalCard() {},
    cancelActiveRun() {},
    queuePrompt() {},
  };
  const editor: KeyBindingEditor = {
    getText: () => "",
    isShowingAutocomplete: () => false,
  };
  const app: KeyBindingAppHooks = {
    handleCtrlC: () => false,
    handleCtrlVImagePaste: async () => {},
    handleCtrlOWithCooldown() {},
    toggleLiveUpdatesPaused() {},
    handleTabQueue: () => false,
  };
  return {
    controller,
    editor,
    app,
    state: createInitialUiState({ cwd: "/repo" }),
    ...overrides,
  };
}

function makeRegistry(): TuiExtensionRegistry {
  // Hermetic registry: no disk roots, no profile root (pointed at an
  // unused temp path via extensionRoots:[]).
  return new TuiExtensionRegistry({
    cwd: "/tmp/nonexistent",
    extensionRoots: [],
  });
}

// Minimal TypeDescriptor stub; panel-renderer lookup does not invoke validate.
const STUB_SCHEMA: TypeDescriptor<Record<string, unknown>> = {
  schema: {},
  validate: (input): input is Record<string, unknown> =>
    typeof input === "object" && input !== null,
};

describe("bootExtensions", () => {
  test("fixture extension's registerKeyBinding flows through with namespaced id and dispatches", async () => {
    const registry = makeRegistry();
    let runCalls = 0;
    const extension: TuiExtension = {
      metadata: {
        name: "bootext-kb",
        version: "1.0.0",
        description: "fixture keybinding extension",
      },
      activate(ctx) {
        ctx.registerKeyBinding({
          id: "sequence",
          category: "custom",
          label: "bootext sequence",
          match: (data) => data === "\u0001bootext-kb-sequence\u0001",
          run(): BindingResult {
            runCalls += 1;
            return { consume: true };
          },
        });
      },
    };
    registry.registerBuiltinExtension(extension);

    const logs: { level: string; text: string }[] = [];
    await bootExtensions("/tmp/nonexistent", {
      registry,
      log: (level, text) => logs.push({ level, text }),
    });

    const ids = listKeyBindings().map((b) => b.id);
    expect(ids).toContain("bootext-kb/sequence");

    // Bindings must NOT be registered under their bare id; the namespace
    // is the whole point of the wrapper.
    expect(ids).not.toContain("sequence");

    const result = dispatchKeyBinding("\u0001bootext-kb-sequence\u0001", makeBindingCtx());
    expect(result).toEqual({ consume: true });
    expect(runCalls).toBe(1);
    expect(logs).toEqual([]);
  });

  test("fixture extension's chrome contribution appears in its requested slot with namespaced id", async () => {
    const registry = makeRegistry();
    const extension: TuiExtension = {
      metadata: {
        name: "bootext-chrome",
        version: "1.0.0",
        description: "fixture chrome extension",
      },
      activate(ctx) {
        ctx.registerChromeContribution({
          id: "badge",
          slot: "footer",
          // Return a sentinel value; consumers only care that this
          // contribution is in the footer slot after boot.
          render: () => ({ __bootext: true } as unknown as never),
        });
      },
    };
    registry.registerBuiltinExtension(extension);

    await bootExtensions("/tmp/nonexistent", {
      registry,
      log: () => {},
    });

    const footerIds = getChromeContributions("footer").map((c) => c.id);
    expect(footerIds).toContain("bootext-chrome/badge");
    expect(footerIds).not.toContain("badge");
  });

  test("fixture extension's panel renderer is registered under its bare rendererId (renderers are not namespaced)", async () => {
    const registry = makeRegistry();
    let renderCalls = 0;
    const rendererId = "bootext-panel-fixture/unique@1";
    const renderer: PanelRenderer<Record<string, unknown>> = {
      rendererId,
      schema: STUB_SCHEMA,
      render({ payload }) {
        renderCalls += 1;
        // Return the payload itself as a sentinel; the test only needs to
        // observe that the registered render function is the one invoked.
        return payload as unknown as never;
      },
    };
    const extension: TuiExtension = {
      metadata: {
        name: "bootext-panel",
        version: "1.0.0",
        description: "fixture panel renderer extension",
      },
      activate(ctx) {
        ctx.registerPanelRenderer(renderer);
      },
    };
    registry.registerBuiltinExtension(extension);

    const logs: { level: string; text: string }[] = [];
    await bootExtensions("/tmp/nonexistent", {
      registry,
      log: (level, text) => logs.push({ level, text }),
    });

    // Renderers are the public contract procedures target via ui.panel,
    // so they are NOT namespaced by the extension name. The bare
    // rendererId resolves directly, and no namespaced form exists.
    const resolved = getPanelRenderer(rendererId);
    expect(resolved).toBeDefined();
    expect(getPanelRenderer(`bootext-panel/${rendererId}`)).toBeUndefined();

    const state = createInitialUiState({ cwd: "/repo" });
    const theme = createNanobossTuiTheme();
    resolved?.render({ payload: { marker: "hi" }, state, theme });
    expect(renderCalls).toBe(1);

    // A first registration under a fresh id does not produce a shadow
    // warning.
    expect(logs.filter((entry) => entry.level === "warning" && entry.text.includes("shadows"))).toHaveLength(0);
  });

  test("a higher-precedence extension registering the same rendererId shadows a lower one and emits a warning", async () => {
    // Simulate a repo extension shadowing a builtin's registration of the
    // same rendererId. The registry activates builtin → repo in scope
    // order, so the repo extension's register call hits an already-present
    // renderer and must emit a shadow warning while taking over.
    const registry = makeRegistry();
    const shadowedId = "shadow-test/renderer@1";

    let builtinRenderCalls = 0;
    let repoRenderCalls = 0;

    const builtin: TuiExtension = {
      metadata: {
        name: "shadow-builtin",
        version: "1.0.0",
        description: "low-tier renderer provider",
      },
      activate(ctx) {
        ctx.registerPanelRenderer({
          rendererId: shadowedId,
          schema: STUB_SCHEMA,
          render(args) {
            builtinRenderCalls += 1;
            return args.payload as unknown as never;
          },
        });
      },
    };

    const repoShadow: TuiExtension = {
      metadata: {
        name: "shadow-repo",
        version: "1.0.0",
        description: "high-tier shadow renderer",
      },
      activate(ctx) {
        ctx.registerPanelRenderer({
          rendererId: shadowedId,
          schema: STUB_SCHEMA,
          render(args) {
            repoRenderCalls += 1;
            return args.payload as unknown as never;
          },
        });
      },
    };

    registry.registerBuiltinExtension(builtin);
    registry.registerExtension("repo", repoShadow);

    const logs: { level: string; text: string }[] = [];
    await bootExtensions("/tmp/nonexistent", {
      registry,
      log: (level, text) => logs.push({ level, text }),
    });

    const resolved = getPanelRenderer(shadowedId);
    expect(resolved).toBeDefined();

    const state = createInitialUiState({ cwd: "/repo" });
    const theme = createNanobossTuiTheme();
    resolved?.render({ payload: {}, state, theme });
    expect(repoRenderCalls).toBe(1);
    expect(builtinRenderCalls).toBe(0);

    const shadowWarnings = logs.filter(
      (entry) =>
        entry.level === "warning"
        && entry.text.includes("[shadow-repo]")
        && entry.text.includes(shadowedId)
        && entry.text.includes("shadows"),
    );
    expect(shadowWarnings.length).toBeGreaterThanOrEqual(1);
  });

  test("after bootExtensions runs, the built-in nb/card@1 renderer is resolvable and renders a sample card payload", async () => {
    // We do NOT pass a pre-built registry, so bootExtensions seeds and
    // activates the adapter-owned nanoboss-core-ui builtin through the
    // catalog path, registering nb/card@1.
    await bootExtensions("/tmp/nonexistent", {
      extensionRoots: [],
      skipDisk: true,
      log: () => {},
    });

    const renderer = getPanelRenderer("nb/card@1");
    expect(renderer).toBeDefined();

    const theme = createNanobossTuiTheme();
    const state = createInitialUiState({ cwd: "/repo" });
    // Renderer must validate the schema and produce a component without
    // throwing for a plausible card payload.
    const component = renderer?.render({
      payload: { kind: "summary", title: "hello", markdown: "body" },
      state,
      theme,
    });
    expect(component).toBeDefined();
  });

  test("a throwing activate is isolated, other extensions still activate, and an aggregate status line is emitted", async () => {
    const registry = makeRegistry();
    let healthyActivated = 0;
    const healthy: TuiExtension = {
      metadata: {
        name: "bootext-healthy",
        version: "1.0.0",
        description: "fixture healthy extension",
      },
      activate(ctx: TuiExtensionContext) {
        healthyActivated += 1;
        ctx.registerKeyBinding({
          id: "ping",
          category: "custom",
          label: "healthy ping",
          match: (data) => data === "\u0001bootext-healthy-ping\u0001",
          run() { return { consume: true }; },
        });
      },
    };
    const broken: TuiExtension = {
      metadata: {
        name: "bootext-broken",
        version: "1.0.0",
        description: "fixture broken extension",
      },
      activate() {
        throw new Error("boom");
      },
    };
    registry.registerBuiltinExtension(healthy);
    registry.registerBuiltinExtension(broken);

    const logs: { level: string; text: string }[] = [];
    const result = await bootExtensions("/tmp/nonexistent", {
      registry,
      log: (level, text) => logs.push({ level, text }),
    });

    // Healthy activation proceeded despite broken throwing.
    expect(healthyActivated).toBe(1);
    const ids = listKeyBindings().map((b) => b.id);
    expect(ids).toContain("bootext-healthy/ping");

    const statusByName = new Map(
      result.registry.listMetadata().map((entry) => [entry.metadata.name, entry]),
    );
    expect(statusByName.get("bootext-healthy")?.status).toBe("active");
    expect(statusByName.get("bootext-broken")?.status).toBe("failed");

    // Aggregate status surfaced once, with the exact count, as an error.
    expect(result.failedCount).toBe(1);
    expect(result.aggregateStatus).toBe("[extensions] 1 extension failed to activate");
    const aggregateHits = logs.filter((entry) => entry.text.includes("failed to activate"));
    expect(aggregateHits.length).toBeGreaterThanOrEqual(1);
    const aggregateEntry = aggregateHits.find((entry) => entry.text === result.aggregateStatus);
    expect(aggregateEntry).toBeDefined();
    expect(aggregateEntry?.level).toBe("error");

    // The per-extension failure is routed through ctx.log.error and includes
    // the extension name so the user can act on it.
    const perExtension = logs.find(
      (entry) => entry.level === "error" && entry.text.includes("[bootext-broken]") && entry.text.includes("boom"),
    );
    expect(perExtension).toBeDefined();
  });
});
