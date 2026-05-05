import type {
  ActivityBarLine,
  ActivityBarSegment as SdkActivityBarSegment,
} from "@nanoboss/tui-extension-sdk";
import type { UiState } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";
import { visibleWidth } from "./pi-tui.ts";

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

interface SegmentCascadeState {
  segment: ActivityBarSegment;
  detail: number;
  dropped: boolean;
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

  const states: SegmentCascadeState[] = segments.map((segment) => ({
    segment,
    detail: 0,
    dropped: false,
  }));

  const renderLine = (): string => {
    const parts: string[] = [];
    for (const entry of states) {
      if (entry.dropped) {
        continue;
      }
      const text = entry.segment.render({
        state,
        theme,
        nowMs,
        detail: entry.detail,
      });
      if (text !== undefined && text.length > 0) {
        parts.push(text);
      }
    }
    return parts.join(separator);
  };

  let current = renderLine();
  if (width === undefined || width <= 0) {
    return current;
  }

  // Degrade in priority order (lowest priority first). A degradation
  // either advances detail by one (if the segment still has headroom)
  // or drops the segment (if droppable). Segments with detailLevels=0
  // drop immediately on their first degradation step, matching the old
  // single-segment behavior.
  const degradationOrder = [...states].sort((a, b) => {
    const priorityA = a.segment.priority ?? 0;
    const priorityB = b.segment.priority ?? 0;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    return (insertionIndex.get(a.segment.id) ?? 0) - (insertionIndex.get(b.segment.id) ?? 0);
  });

  while (visibleWidth(current) > width) {
    let stepped = false;
    for (const entry of degradationOrder) {
      if (entry.dropped) {
        continue;
      }
      const maxDetail = entry.segment.detailLevels ?? 0;
      if (entry.detail < maxDetail) {
        entry.detail += 1;
        stepped = true;
        break;
      }
      if (entry.segment.droppable !== false) {
        entry.dropped = true;
        stepped = true;
        break;
      }
    }
    if (!stepped) {
      break;
    }
    current = renderLine();
  }

  return current;
}
