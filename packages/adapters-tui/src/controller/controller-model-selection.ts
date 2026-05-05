import type { DownstreamAgentSelection } from "@nanoboss/contracts";
import { createTextPromptInput } from "@nanoboss/procedure-sdk";

import { buildModelCommand } from "../shared/model-command.ts";
import type { UiAction } from "../reducer/reducer-actions.ts";
import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";
import {
  validateInlineModelSelection,
  type ControllerInlineModelValidationDeps,
} from "./controller-model-inline-validation.ts";
import {
  createLocalAgentSelectionAction,
  maybePersistDefaultSelection,
} from "./controller-model-persistence.ts";

export interface ControllerModelSelectionDeps extends ControllerInlineModelValidationDeps {
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
