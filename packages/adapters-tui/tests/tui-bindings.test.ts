import { describe, expect, test } from "bun:test";

import {
  createInitialUiState,
  type UiState,
} from "@nanoboss/adapters-tui";
import type {
  BindingResult,
  KeyBindingController,
  KeyBindingEditor,
} from "@nanoboss/tui-extension-sdk";
import {
  dispatchKeyBinding,
  listKeyBindings,
  registerKeyBinding,
  type BindingCtx,
  type KeyBinding,
  type KeyBindingAppHooks,
} from "../src/core/bindings.ts";

function makeController(overrides: Partial<KeyBindingController> = {}): KeyBindingController {
  return {
    toggleToolOutput() {},
    toggleToolCardsHidden() {},
    toggleSimplify2AutoApprove() {},
    showLocalCard() {},
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
    // esc only dispatches when a run is active. With no run active it must
    // fall through so the editor can consume the key itself.
    const idleState: UiState = {
      ...createInitialUiState({ cwd: "/repo" }),
      inputDisabled: false,
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

  test("ctrl+h emits a keybindings help card through showLocalCard", () => {
    const state: UiState = {
      ...createInitialUiState({ cwd: "/repo" }),
    };

    const cardCalls: Array<{ title: string; markdown: string; key?: string }> = [];
    const ctx = makeCtx(state, {
      controller: makeController({
        showLocalCard: (opts) => {
          cardCalls.push({ title: opts.title, markdown: opts.markdown, key: opts.key });
        },
      }),
    });

    const result = dispatchKeyBinding("\b", ctx);
    expect(result).toEqual({ consume: true });
    expect(cardCalls).toHaveLength(1);
    expect(cardCalls[0]!.title).toBe("Keybindings");
    // Each invocation appends a fresh card (no stable key) so users can
    // re-summon help even when an earlier card has scrolled off-screen.
    expect(cardCalls[0]!.key).toBeUndefined();
    expect(cardCalls[0]!.markdown).toContain("Send / compose");
  });

  test("dispatch supports function matchers", () => {
    const suffix = Math.random().toString(36).slice(2);
    const id = `test.function-match.${suffix}`;
    const calls: string[] = [];
    registerKeyBinding({
      id,
      category: "custom",
      label: "function matcher",
      match: (data) => data === `custom-sequence-${suffix}`,
      run: () => {
        calls.push("matched");
        return { consume: true };
      },
    });

    const state = createInitialUiState({ cwd: "/repo" });
    const ctx = makeCtx(state);
    expect(dispatchKeyBinding(`custom-sequence-${suffix}`, ctx)).toEqual({ consume: true });
    expect(dispatchKeyBinding(`other-${suffix}`, ctx)).toBeUndefined();
    expect(calls).toEqual(["matched"]);
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
      inputDisabledReason: "run",
    };
    const ctx = makeCtx(state, {
      app: makeAppHooks({ handleTabQueue: () => false }),
    });
    const result = dispatchKeyBinding("\t", ctx);
    expect(result).toBeUndefined();
  });
});
