import { describe, expect, test } from "bun:test";

import {
  createInitialUiState,
  dispatchKeyBinding,
  keyMatches,
  listKeyBindings,
  registerKeyBinding,
  type BindingCtx,
  type KeyBinding,
  type KeyBindingAppHooks,
  type KeyBindingController,
  type KeyBindingEditor,
  type UiState,
} from "@nanoboss/adapters-tui";

function makeController(overrides: Partial<KeyBindingController> = {}): KeyBindingController {
  return {
    toggleToolOutput() {},
    toggleToolCardsHidden() {},
    toggleSimplify2AutoApprove() {},
    toggleKeybindingOverlay() {},
    dismissKeybindingOverlay() {},
    cancelActiveRun() {},
    queuePrompt() {},
    ...overrides,
  };
}

function makeEditor(overrides: Partial<KeyBindingEditor> = {}): KeyBindingEditor {
  return {
    getText: () => "",
    isShowingAutocomplete: () => false,
    ...overrides,
  };
}

function makeAppHooks(overrides: Partial<KeyBindingAppHooks> = {}): KeyBindingAppHooks {
  return {
    handleCtrlC: () => false,
    handleCtrlVImagePaste: async () => {},
    handleCtrlOWithCooldown() {},
    toggleLiveUpdatesPaused() {},
    handleTabQueue: () => false,
    ...overrides,
  };
}

function makeCtx(
  state: UiState,
  partial: Partial<BindingCtx> = {},
): BindingCtx {
  return {
    controller: makeController(),
    state,
    editor: makeEditor(),
    app: makeAppHooks(),
    ...partial,
  };
}

describe("keybinding registry", () => {
  test("registers core bindings loaded via side-effect import", () => {
    const ids = listKeyBindings().map((b) => b.id);
    // Sanity: every previously supported binding is present under its
    // canonical id. If any of these drops out, dispatch for the
    // corresponding key will silently stop working.
    expect(ids).toContain("tools.toggleOutput");
    expect(ids).toContain("run.toggleAutoApprove");
    expect(ids).toContain("run.togglePause");
    expect(ids).toContain("run.toggleToolCards");
    expect(ids).toContain("run.stop");
    expect(ids).toContain("run.queue");
    expect(ids).toContain("overlay.toggle");
    expect(ids).toContain("custom.clipboardPaste");
    expect(ids).toContain("custom.ctrlCExit");
  });

  test("registerKeyBinding rejects duplicate ids", () => {
    // The core-bindings side effect already registered
    // overlay.toggle; attempting to register the same id must throw so
    // two authors cannot silently shadow each other.
    const dup: KeyBinding = {
      id: "overlay.toggle",
      category: "overlay",
      label: "duplicate",
    };
    expect(() => registerKeyBinding(dup)).toThrow(/already registered/);
  });

  test("listKeyBindings preserves insertion order within equal `order` values", () => {
    const bindings = listKeyBindings().filter((b) => b.category === "theme");
    const ids = bindings.map((b) => b.id);
    expect(ids).toEqual(["theme.light", "theme.dark"]);
  });

  test("keyMatches delegates to pi-tui matchesKey for string identifiers", () => {
    // ctrl+k encodes as the VT byte 0x0b.
    expect(keyMatches("ctrl+k", "\u000b")).toBe(true);
    expect(keyMatches("ctrl+o", "\u000b")).toBe(false);
  });

  test("keyMatches supports function matchers", () => {
    const match = (data: string) => data === "custom-sequence";
    expect(keyMatches(match, "custom-sequence")).toBe(true);
    expect(keyMatches(match, "other")).toBe(false);
  });

  test("dispatch selects the correct binding for ctrl+o and calls its hook", () => {
    let ctrlOCooldownCalls = 0;
    const state = createInitialUiState({ cwd: "/repo" });
    const ctx = makeCtx(state, {
      app: makeAppHooks({
        handleCtrlOWithCooldown: () => {
          ctrlOCooldownCalls += 1;
        },
      }),
    });

    const result = dispatchKeyBinding("\u000f", ctx);
    expect(result).toEqual({ consume: true });
    expect(ctrlOCooldownCalls).toBe(1);
  });

  test("when predicate gates dispatch without affecting overlay listing", () => {
    // esc only dispatches when a run is active or the overlay is open.
    // With neither condition true it must fall through so the editor
    // can consume the key itself.
    const idleState: UiState = {
      ...createInitialUiState({ cwd: "/repo" }),
      inputDisabled: false,
      keybindingOverlayVisible: false,
    };

    let cancelled = 0;
    const ctx = makeCtx(idleState, {
      controller: makeController({
        cancelActiveRun: () => {
          cancelled += 1;
        },
      }),
    });
    const result = dispatchKeyBinding("\u001b", ctx);
    expect(result).toBeUndefined();
    expect(cancelled).toBe(0);

    // esc still appears in the overlay listing because listKeyBindings
    // ignores `when` — overlay is documentation, not dispatch.
    const stopBinding = listKeyBindings().find((b) => b.id === "run.stop");
    expect(stopBinding?.label).toBe("esc stop");
  });

  test("dispatch dismisses the overlay first when both overlay and run are active", () => {
    const state: UiState = {
      ...createInitialUiState({ cwd: "/repo" }),
      inputDisabled: true,
      keybindingOverlayVisible: true,
    };

    let dismissCalls = 0;
    let cancelCalls = 0;
    const ctx = makeCtx(state, {
      controller: makeController({
        dismissKeybindingOverlay: () => {
          dismissCalls += 1;
        },
        cancelActiveRun: () => {
          cancelCalls += 1;
        },
      }),
    });

    const result = dispatchKeyBinding("\u001b", ctx);
    expect(result).toEqual({ consume: true });
    expect(dismissCalls).toBe(1);
    // When the overlay is visible, esc must not also cancel the run in
    // the same keystroke.
    expect(cancelCalls).toBe(0);
  });

  test("docs-only bindings with no matcher never dispatch", () => {
    // theme.light is registered as a docs-only overlay entry. No key
    // input should resolve to it, even if its label appears in the
    // overlay.
    const state = createInitialUiState({ cwd: "/repo" });
    const ctx = makeCtx(state);
    const result = dispatchKeyBinding("/light", ctx);
    expect(result).toBeUndefined();
  });

  test("run can decline by returning consume: false, letting dispatch fall through", () => {
    // run.queue's handleTabQueue returns false when autocomplete is
    // showing; dispatch must then return undefined so the editor sees
    // the tab.
    const state: UiState = {
      ...createInitialUiState({ cwd: "/repo" }),
      inputDisabled: true,
    };
    const ctx = makeCtx(state, {
      app: makeAppHooks({ handleTabQueue: () => false }),
    });
    const result = dispatchKeyBinding("\t", ctx);
    expect(result).toBeUndefined();
  });
});
