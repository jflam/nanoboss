import type {
  ActivityBarLine,
  ActivityBarSegment as SdkActivityBarSegment,
} from "@nanoboss/tui-extension-sdk";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import { renderActivityBarCascade } from "./activity-bar-cascade.ts";

export type ActivityBarSegment =
  SdkActivityBarSegment<UiState, NanobossTuiTheme>;

const registry = new Map<string, ActivityBarSegment>();
const insertionIndex = new Map<string, number>();
let nextInsertionIndex = 0;

export function registerActivityBarSegment(segment: ActivityBarSegment): void {
  if (registry.has(segment.id)) {
    throw new Error(`activity-bar segment already registered: ${segment.id}`);
  }
  registry.set(segment.id, segment);
  insertionIndex.set(segment.id, nextInsertionIndex);
  nextInsertionIndex += 1;
}

function getActivityBarSegments(line: ActivityBarLine): ActivityBarSegment[] {
  return Array.from(registry.values())
    .filter((segment) => segment.line === line)
    .sort(compareByOrder);
}

function compareByOrder(a: ActivityBarSegment, b: ActivityBarSegment): number {
  const orderA = a.order ?? 0;
  const orderB = b.order ?? 0;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  return (insertionIndex.get(a.id) ?? 0) - (insertionIndex.get(b.id) ?? 0);
}

/**
 * Build a single activity-bar line by rendering every registered segment
 * for that line and applying the priority-drop cascade when the resulting
 * line exceeds the given width. When width is undefined, the line is
 * rendered at full detail with no degradation.
 */
export function buildActivityBarLine(
  line: ActivityBarLine,
  state: UiState,
  theme: NanobossTuiTheme,
  nowMs: number,
  separator: string,
  width?: number,
): string | undefined {
  const segments = getActivityBarSegments(line).filter((segment) => {
    if (segment.shouldRender && !segment.shouldRender(state)) {
      return false;
    }
    return true;
  });
  if (segments.length === 0) {
    return undefined;
  }

  return renderActivityBarCascade({
    segments,
    state,
    theme,
    nowMs,
    separator,
    width,
    getOrderIndex: (segment) => insertionIndex.get(segment.id) ?? 0,
  });
}
