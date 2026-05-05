import type { DownstreamAgentSelection } from "@nanoboss/contracts";
import { createTextPromptInput } from "@nanoboss/procedure-sdk";
import {
  discoverAgentCatalog,
  formatAgentCatalogRefreshError,
  getProviderLabel,
  hasAgentCatalogRefreshedToday,
  isKnownModelSelectionInCatalog,
} from "@nanoboss/agent-acp";

import { formatAgentSelectionLabel } from "./agent-label.ts";
import { buildModelCommand } from "./model-command.ts";
import type { UiAction } from "./reducer-actions.ts";
import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";

export interface ControllerModelSelectionDeps {
  discoverAgentCatalog?: typeof discoverAgentCatalog;
  hasAgentCatalogRefreshedToday?: typeof hasAgentCatalogRefreshedToday;
  confirmPersistDefaultAgentSelection?: (
    selection: DownstreamAgentSelection,
  ) => Promise<boolean>;
  persistDefaultAgentSelection?: (selection: DownstreamAgentSelection) => Promise<void> | void;
  promptForModelSelection?: (
    currentSelection?: DownstreamAgentSelection,
  ) => Promise<DownstreamAgentSelection | undefined>;
}

type WithLocalBusy = <T>(status: string, work: () => Promise<T>) => Promise<T>;
type ShowLocalCard = (opts: ControllerLocalCardOptions) => void;
type Dispatch = (action: UiAction) => void;

async function validateInlineModelSelection(params: {
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

function createLocalAgentSelectionAction(selection: DownstreamAgentSelection): UiAction {
  return {
    type: "local_agent_selection",
    agentLabel: formatAgentSelectionLabel(selection),
    selection,
  };
}

async function maybePersistDefaultSelection(params: {
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

export async function applyInlineModelSelection(params: {
  selection: DownstreamAgentSelection;
  cwd: string;
  deps: ControllerModelSelectionDeps;
  withLocalBusy: WithLocalBusy;
  showLocalCard: ShowLocalCard;
  dispatch: Dispatch;
}): Promise<void> {
  const validatedSelection = await validateInlineModelSelection({
    selection: params.selection,
    cwd: params.cwd,
    deps: params.deps,
    withLocalBusy: params.withLocalBusy,
    showLocalCard: params.showLocalCard,
  });
  if (!validatedSelection) {
    return;
  }

  params.dispatch(createLocalAgentSelectionAction(validatedSelection));
  await maybePersistDefaultSelection({
    selection: validatedSelection,
    deps: params.deps,
    showLocalCard: params.showLocalCard,
  });
}

export async function openModelPicker(params: {
  currentSelection?: DownstreamAgentSelection;
  deps: ControllerModelSelectionDeps;
  withLocalBusy: WithLocalBusy;
  showLocalCard: ShowLocalCard;
  dispatch: Dispatch;
  onAddHistory?: (text: string) => void;
  forwardPrompt: (prompt: ReturnType<typeof createTextPromptInput>) => Promise<boolean>;
}): Promise<void> {
  let selection: DownstreamAgentSelection | undefined;
  try {
    selection = await params.withLocalBusy(
      "[model] choose an agent",
      async () => await params.deps.promptForModelSelection?.(params.currentSelection),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.showLocalCard({
      key: "local:model",
      title: "Model",
      markdown: `Model picker failed: ${message}`,
      severity: "error",
    });
    return;
  }

  if (!selection) {
    return;
  }

  params.dispatch(createLocalAgentSelectionAction(selection));
  await maybePersistDefaultSelection({
    selection,
    deps: params.deps,
    showLocalCard: params.showLocalCard,
  });
  const command = buildModelCommand(selection.provider, selection.model ?? "default");
  params.onAddHistory?.(command);
  await params.forwardPrompt(createTextPromptInput(command));
}
