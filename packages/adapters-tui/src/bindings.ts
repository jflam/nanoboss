import type { UiState } from "./state.ts";
import { matchesKey, type KeyId } from "./pi-tui.ts";
import type { PromptInput } from "@nanoboss/procedure-sdk";

export type KeyMatcher = KeyId | ((data: string) => boolean);

export type KeyBindingCategory =
  | "compose"
  | "run"
  | "tools"
  | "theme"
  | "commands"
  | "overlay"
  | "custom";

export interface BindingResult {
  consume?: boolean;
}

/**
 * Context passed to a KeyBinding's run() at dispatch time. The shape is
 * intentionally minimal: controller covers state-changing side effects,
 * state gives read-only gating information, editor exposes composer text
 * access, and app exposes the handful of app-private hooks that a few
 * bindings (ctrl+c, ctrl+v, ctrl+p, ctrl+o cooldown, tab queue) need.
 */
export interface BindingCtx {
  controller: KeyBindingController;
  state: UiState;
  editor: KeyBindingEditor;
  app: KeyBindingAppHooks;
}

export interface KeyBindingController {
  toggleToolOutput(): void;
  toggleToolCardsHidden(): void;
  toggleSimplify2AutoApprove(): void;
  toggleKeybindingOverlay(): void;
  dismissKeybindingOverlay(): void;
  cancelActiveRun(): Promise<void> | void;
  queuePrompt(input: string | PromptInput): Promise<void> | void;
}

export interface KeyBindingEditor {
  getText(): string;
  isShowingAutocomplete(): boolean;
}

/**
 * App-private hooks exposed to registered bindings. These wrap behavior
 * that depends on state the controller does not own (clipboard, pause
 * toggle, debounce windows, structured prompt construction).
 */
export interface KeyBindingAppHooks {
  handleCtrlC(): boolean;
  handleCtrlVImagePaste(): Promise<void>;
  handleCtrlOWithCooldown(): void;
  toggleLiveUpdatesPaused(): void;
  handleTabQueue(): boolean;
}

export interface KeyBinding {
  /** Stable identifier; registrations are deduplicated by id. */
  id: string;
  /**
   * Key identifier or a matcher function. If omitted, this binding is
   * docs-only: it appears in the overlay but never dispatches.
   */
  match?: KeyMatcher;
  /** State-level gate. If it returns false the binding is skipped. */
  when?: (state: UiState) => boolean;
  category: KeyBindingCategory;
  /** Human-readable one-line description shown in the overlay. */
  label: string;
  /** Insertion-order tiebreak within a category; lower comes first. */
  order?: number;
  run?: (ctx: BindingCtx) => void | Promise<void> | BindingResult | undefined;
}

const registry = new Map<string, KeyBinding>();
const insertionIndex = new Map<string, number>();
let nextInsertionIndex = 0;

export function registerKeyBinding(binding: KeyBinding): void {
  if (registry.has(binding.id)) {
    throw new Error(`keybinding already registered: ${binding.id}`);
  }
  registry.set(binding.id, binding);
  insertionIndex.set(binding.id, nextInsertionIndex);
  nextInsertionIndex += 1;
}

/**
 * Returns all registered bindings in stable order: by optional `order`
 * then by insertion index. Callers may filter/group further.
 */
export function listKeyBindings(): KeyBinding[] {
  return Array.from(registry.values()).sort((a, b) => {
    const orderA = a.order ?? 0;
    const orderB = b.order ?? 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return (insertionIndex.get(a.id) ?? 0) - (insertionIndex.get(b.id) ?? 0);
  });
}

export function keyMatches(match: KeyMatcher | undefined, data: string): boolean {
  if (match === undefined) {
    return false;
  }
  if (typeof match === "function") {
    return match(data);
  }
  return matchesKey(data, match);
}

/**
 * Runs the registered bindings in order and returns the first result whose
 * `run` indicates it consumed the input. Bindings gated out by `when`, or
 * whose matcher does not accept `data`, are skipped. Returns `undefined`
 * when no binding consumed the input.
 *
 * The dispatcher is synchronous: if a binding's `run` returns a Promise
 * it is treated as fire-and-forget (consumed) and the caller does not
 * wait on it. This matches pi-tui's sync input-listener contract while
 * letting binding implementations kick off async work (e.g. clipboard
 * reads) via void-promises.
 */
export function dispatchKeyBinding(
  data: string,
  ctx: BindingCtx,
): BindingResult | undefined {
  for (const binding of listKeyBindings()) {
    if (binding.when && !binding.when(ctx.state)) {
      continue;
    }
    if (!keyMatches(binding.match, data)) {
      continue;
    }
    if (!binding.run) {
      // Docs-only binding: the matcher accepted the input but no
      // action is attached; continue looking for a later binding
      // that also matches and has a run().
      continue;
    }
    const raw = binding.run(ctx);
    if (raw instanceof Promise) {
      return { consume: true };
    }
    const result = raw as BindingResult | void | undefined;
    if (result && result.consume === false) {
      continue;
    }
    return result ?? { consume: true };
  }
  return undefined;
}
