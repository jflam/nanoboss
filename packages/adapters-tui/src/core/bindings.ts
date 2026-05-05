import type {
  BindingCtx as SdkBindingCtx,
  BindingResult,
  KeyBinding as SdkKeyBinding,
  KeyBindingAppHooks,
  KeyBindingCategory,
  KeyBindingController,
  KeyBindingEditor,
  KeyMatcher,
} from "@nanoboss/tui-extension-sdk";
import type { UiState } from "../state/state.ts";
import { matchesKey } from "../shared/pi-tui.ts";

export type {
  KeyBindingAppHooks,
  KeyBindingCategory,
} from "@nanoboss/tui-extension-sdk";

export type BindingCtx = SdkBindingCtx<UiState>;
export type KeyBinding = SdkKeyBinding<UiState>;

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

function keyMatches(match: KeyMatcher | undefined, data: string): boolean {
  if (match === undefined) {
    return false;
  }
  if (typeof match === "function") {
    return match(data);
  }
  return matchesKey(data, match as Parameters<typeof matchesKey>[1]);
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
