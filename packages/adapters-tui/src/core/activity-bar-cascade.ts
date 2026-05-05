import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import { visibleWidth } from "../shared/pi-tui.ts";
import type { ActivityBarSegment } from "./activity-bar.ts";

interface SegmentCascadeState {
  segment: ActivityBarSegment;
  detail: number;
  dropped: boolean;
}

export function renderActivityBarCascade(params: {
  segments: ActivityBarSegment[];
  state: UiState;
  theme: NanobossTuiTheme;
  nowMs: number;
  separator: string;
  width?: number;
  getOrderIndex: (segment: ActivityBarSegment) => number;
}): string {
  const states: SegmentCascadeState[] = params.segments.map((segment) => ({
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
        state: params.state,
        theme: params.theme,
        nowMs: params.nowMs,
        detail: entry.detail,
      });
      if (text !== undefined && text.length > 0) {
        parts.push(text);
      }
    }
    return parts.join(params.separator);
  };

  let current = renderLine();
  if (params.width === undefined || params.width <= 0) {
    return current;
  }

  const degradationOrder = [...states].sort((a, b) => {
    const priorityA = a.segment.priority ?? 0;
    const priorityB = b.segment.priority ?? 0;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    return params.getOrderIndex(a.segment) - params.getOrderIndex(b.segment);
  });

  while (visibleWidth(current) > params.width) {
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
