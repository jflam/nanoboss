import type { ActivityBarSegment } from "./activity-bar.ts";
import type { TokenUsageSummary } from "../shared/format.ts";
import { formatCompactTokenUsage, stripModelQualifier } from "../shared/format.ts";
import type { UiState } from "../state/state.ts";

function getActivityBarModelLabel(state: UiState): string {
  const selection = state.defaultAgentSelection;
  if (!selection) {
    return state.agentLabel || "connecting";
  }
  const prefix = `${selection.provider}/`;
  if (state.agentLabel.startsWith(prefix)) {
    return state.agentLabel.slice(prefix.length) || "default";
  }
  return selection.model || "default";
}

function buildTokenUsageText(
  state: UiState,
  options: { includePercent: boolean; includeLimit: boolean },
): string | undefined {
  if (state.tokenUsage) {
    const compact = formatCompactTokenUsage(state.tokenUsage as TokenUsageSummary, options);
    if (compact) {
      return compact;
    }
  }
  return state.tokenUsageLine;
}

export function getCoreIdentitySegments(): ActivityBarSegment[] {
  return [
    {
      id: "identity.agent",
      line: "identity",
      order: 0,
      priority: 1,
      detailLevels: 0,
      droppable: true,
      render: ({ state, theme }) => {
        const selection = state.defaultAgentSelection;
        if (!selection) {
          return theme.accent(`@${state.agentLabel || "connecting"}`);
        }
        return theme.accent(`@${selection.provider}`);
      },
    },
    {
      id: "identity.model",
      line: "identity",
      order: 1,
      priority: 2,
      detailLevels: 1,
      droppable: false,
      shouldRender: (state) => state.defaultAgentSelection !== undefined,
      render: ({ state, theme, detail }) => {
        const modelLabel = getActivityBarModelLabel(state);
        const effective = detail >= 1 ? stripModelQualifier(modelLabel) : modelLabel;
        return theme.accent(effective);
      },
    },
    {
      id: "identity.token-usage",
      line: "identity",
      order: 2,
      priority: 0,
      detailLevels: 2,
      droppable: false,
      render: ({ state, theme, detail }) => {
        const includeLimit = detail < 2;
        const includePercent = detail < 1;
        const text = buildTokenUsageText(state, { includePercent, includeLimit });
        if (!text) {
          return undefined;
        }
        return theme.success(text);
      },
    },
  ];
}
