import type { Component } from "./pi-tui.ts";
import type { UiState } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";

/**
 * Named slots that compose the nanoboss TUI chrome. Slot order is declared
 * by the renderer (NanobossAppView); contributions only pick which slot they
 * live in and (optionally) their relative order within that slot.
 */
export type ChromeSlotId =
  | "header"
  | "session"
  | "status"
  | "transcriptAbove"
  | "transcript"
  | "transcriptBelow"
  | "composerAbove"
  | "composer"
  | "composerBelow"
  | "activityBar"
  | "overlay"
  | "footer";

/**
 * Per-contribution render context. State is the snapshot captured at
 * rebuild time; getState/getNowMs are live accessors for components that
 * need to update between state changes (e.g. the run timer, footer copy).
 */
export interface ChromeRenderContext {
  state: UiState;
  theme: NanobossTuiTheme;
  getState: () => UiState;
  getNowMs: () => number;
}

export interface ChromeContribution {
  /** Stable identifier; registrations are deduplicated by id. */
  id: string;
  slot: ChromeSlotId;
  /** Insertion-order tiebreak within a slot; lower comes first. */
  order?: number;
  /**
   * Optional state-level gate evaluated once at rebuild time. If it
   * returns false, the contribution is skipped. For contributions that
   * need live gating (e.g. the overlay), prefer leaving this undefined
   * and emitting empty lines from render() based on state instead.
   */
  shouldRender?(state: UiState): boolean;
  render(ctx: ChromeRenderContext): Component;
}

const registry = new Map<string, ChromeContribution>();
const insertionIndex = new Map<string, number>();
let nextInsertionIndex = 0;

export function registerChromeContribution(contribution: ChromeContribution): void {
  if (registry.has(contribution.id)) {
    throw new Error(`chrome contribution already registered: ${contribution.id}`);
  }
  registry.set(contribution.id, contribution);
  insertionIndex.set(contribution.id, nextInsertionIndex);
  nextInsertionIndex += 1;
}

export function listChromeContributions(): ChromeContribution[] {
  return Array.from(registry.values()).sort(compareContributions);
}

export function getChromeContributions(slot: ChromeSlotId): ChromeContribution[] {
  return Array.from(registry.values())
    .filter((c) => c.slot === slot)
    .sort(compareContributions);
}

function compareContributions(a: ChromeContribution, b: ChromeContribution): number {
  const orderA = a.order ?? 0;
  const orderB = b.order ?? 0;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  return (insertionIndex.get(a.id) ?? 0) - (insertionIndex.get(b.id) ?? 0);
}
