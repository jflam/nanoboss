import type { DownstreamAgentSelection } from "@nanoboss/contracts";
import {
  discoverAgentCatalog,
  formatAgentCatalogRefreshError,
  getProviderLabel,
  hasAgentCatalogRefreshedToday,
  isKnownModelSelectionInCatalog,
} from "@nanoboss/agent-acp";

import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";

export interface ControllerInlineModelValidationDeps {
  discoverAgentCatalog?: typeof discoverAgentCatalog;
  hasAgentCatalogRefreshedToday?: typeof hasAgentCatalogRefreshedToday;
}

type WithLocalBusy = <T>(status: string, work: () => Promise<T>) => Promise<T>;
type ShowLocalCard = (opts: ControllerLocalCardOptions) => void;

export async function validateInlineModelSelection(params: {
  selection: DownstreamAgentSelection;
  cwd: string;
  deps: ControllerInlineModelValidationDeps;
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
  const discoverCatalog = async () =>
    await (params.deps.discoverAgentCatalog ?? discoverAgentCatalog)(selection.provider, {
      config: { cwd: params.cwd },
      ...(refreshedToday ? {} : { forceRefresh: true }),
    });

  try {
    const catalog = refreshedToday
      ? await discoverCatalog()
      : await params.withLocalBusy(
          `[model] refreshing ${getProviderLabel(selection.provider)} model cache…`,
          discoverCatalog,
        );
    return isKnownModelSelectionInCatalog(catalog, selection.model) ? selection : undefined;
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
