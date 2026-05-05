import type { DownstreamAgentSelection } from "@nanoboss/contracts";
import {
  discoverAgentCatalog,
  formatAgentCatalogRefreshError,
  getProviderLabel,
  hasAgentCatalogRefreshedToday,
  isKnownModelSelectionInCatalog,
} from "@nanoboss/agent-acp";

import { formatAgentSelectionLabel } from "./agent-label.ts";
import type { UiAction } from "./reducer.ts";
import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";

export interface ControllerModelSelectionDeps {
  discoverAgentCatalog?: typeof discoverAgentCatalog;
  hasAgentCatalogRefreshedToday?: typeof hasAgentCatalogRefreshedToday;
  confirmPersistDefaultAgentSelection?: (
    selection: DownstreamAgentSelection,
  ) => Promise<boolean>;
  persistDefaultAgentSelection?: (selection: DownstreamAgentSelection) => Promise<void> | void;
}

type WithLocalBusy = <T>(status: string, work: () => Promise<T>) => Promise<T>;
type ShowLocalCard = (opts: ControllerLocalCardOptions) => void;

export async function validateInlineModelSelection(params: {
  selection: DownstreamAgentSelection;
  cwd: string;
  deps: ControllerModelSelectionDeps;
  withLocalBusy: WithLocalBusy;
  showLocalCard: ShowLocalCard;
}): Promise<DownstreamAgentSelection | undefined> {
  const { selection } = params;
  if (!selection.model) {
    return undefined;
  }

  const refreshedToday = (params.deps.hasAgentCatalogRefreshedToday ?? hasAgentCatalogRefreshedToday)(
    selection.provider,
    {
      config: { cwd: params.cwd },
    },
  );
  const discoverCatalog = async () => await (params.deps.discoverAgentCatalog ?? discoverAgentCatalog)(
    selection.provider,
    {
      config: { cwd: params.cwd },
      ...(refreshedToday ? {} : { forceRefresh: true }),
    },
  );

  try {
    const catalog = refreshedToday
      ? await discoverCatalog()
      : await params.withLocalBusy(
        `[model] refreshing ${getProviderLabel(selection.provider)} model cache…`,
        discoverCatalog,
      );
    return isKnownModelSelectionInCatalog(catalog, selection.model)
      ? selection
      : undefined;
  } catch (error) {
    params.showLocalCard({
      key: "local:model",
      title: "Model",
      markdown: formatAgentCatalogRefreshError(selection.provider, error),
      severity: "error",
    });
    return undefined;
  }
}

export function createLocalAgentSelectionAction(selection: DownstreamAgentSelection): UiAction {
  return {
    type: "local_agent_selection",
    agentLabel: formatAgentSelectionLabel(selection),
    selection,
  };
}

export async function maybePersistDefaultSelection(params: {
  selection: DownstreamAgentSelection;
  deps: ControllerModelSelectionDeps;
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
