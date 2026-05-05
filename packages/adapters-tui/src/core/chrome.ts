import type {
  ChromeContribution as SdkChromeContribution,
  ChromeRenderContext as SdkChromeRenderContext,
  ChromeSlotId,
} from "@nanoboss/tui-extension-sdk";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

export type { ChromeSlotId } from "@nanoboss/tui-extension-sdk";
export type ChromeRenderContext = SdkChromeRenderContext<UiState, NanobossTuiTheme>;
export type ChromeContribution = SdkChromeContribution<UiState, NanobossTuiTheme>;

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
