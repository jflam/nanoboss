import type { DownstreamAgentSelection } from "@nanoboss/contracts";

import { formatAgentSelectionLabel } from "../shared/agent-label.ts";
import type { UiAction } from "../reducer/reducer-actions.ts";
import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";

interface ControllerModelPersistenceDeps {
  confirmPersistDefaultAgentSelection?: (
    selection: DownstreamAgentSelection,
  ) => Promise<boolean>;
  persistDefaultAgentSelection?: (selection: DownstreamAgentSelection) => Promise<void> | void;
}

type ShowLocalCard = (opts: ControllerLocalCardOptions) => void;

export function createLocalAgentSelectionAction(selection: DownstreamAgentSelection): UiAction {
  return {
    type: "local_agent_selection",
    agentLabel: formatAgentSelectionLabel(selection),
    selection,
  };
}

export async function maybePersistDefaultSelection(params: {
  selection: DownstreamAgentSelection;
  deps: ControllerModelPersistenceDeps;
  showLocalCard: ShowLocalCard;
}): Promise<void> {
  const confirm = params.deps.confirmPersistDefaultAgentSelection;
  const persist = params.deps.persistDefaultAgentSelection;
  if (!confirm || !persist) {
    return;
  }

  try {
    const shouldPersist = await confirm(params.selection);
    if (!shouldPersist) {
      return;
    }

    await persist(params.selection);
    params.showLocalCard({
      key: "local:model",
      title: "Model",
      markdown: `Saved **${formatAgentSelectionLabel(params.selection)}** as the default for future runs.`,
      severity: "info",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.showLocalCard({
      key: "local:model",
      title: "Model",
      markdown: `Failed to save default: ${message}`,
      severity: "error",
    });
  }
}
