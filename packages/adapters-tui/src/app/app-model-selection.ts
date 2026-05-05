import type {
  DownstreamAgentProvider,
  DownstreamAgentSelection,
} from "@nanoboss/contracts";
import {
  discoverAgentCatalog,
  formatAgentCatalogRefreshError,
  getProviderLabel,
  hasAgentCatalogRefreshedToday,
  listKnownProviders,
  listSelectableModelOptionsFromCatalog,
} from "@nanoboss/agent-acp";

import type { ControllerLike, NanobossTuiAppDeps } from "./app-types.ts";
import type { SelectOverlayOptions } from "../overlays/select-overlay.ts";

export interface InlineModelSelectionDeps {
  discoverAgentCatalog?: typeof discoverAgentCatalog;
  hasAgentCatalogRefreshedToday?: typeof hasAgentCatalogRefreshedToday;
}

type PromptWithInlineSelect = <T extends string>(
  options: SelectOverlayOptions<T>,
) => Promise<T | undefined>;

export class AppModelPrompts {
  constructor(
    private readonly params: {
      cwd: string;
      deps: NanobossTuiAppDeps;
      controller: ControllerLike;
      promptWithInlineSelect: PromptWithInlineSelect;
    },
  ) {}

  async promptForModelSelection(
    currentSelection?: DownstreamAgentSelection,
  ): Promise<DownstreamAgentSelection | undefined> {
    return await promptForInlineModelSelection({
      cwd: this.params.cwd,
      currentSelection,
      deps: this.params.deps,
      showStatus: (text) => this.params.controller.showStatus(text),
      promptWithInlineSelect: this.params.promptWithInlineSelect,
    });
  }

  async confirmPersistDefaultAgentSelection(
    selection: DownstreamAgentSelection,
  ): Promise<boolean> {
    return await promptToPersistInlineModelSelection({
      selection,
      promptWithInlineSelect: this.params.promptWithInlineSelect,
    });
  }
}

async function promptForInlineModelSelection(params: {
  cwd: string;
  currentSelection?: DownstreamAgentSelection;
  deps: InlineModelSelectionDeps;
  showStatus: (text: string) => void;
  promptWithInlineSelect: PromptWithInlineSelect;
}): Promise<DownstreamAgentSelection | undefined> {
  const provider = await params.promptWithInlineSelect<DownstreamAgentProvider>({
    title: "Choose an agent",
    items: listKnownProviders().map((value) => ({
      value,
      label: getProviderLabel(value),
    })),
    initialValue: params.currentSelection?.provider,
    footer: "↑↓ navigate • enter select • esc cancel",
  });
  if (!provider) {
    return undefined;
  }

  const refreshedToday = (params.deps.hasAgentCatalogRefreshedToday ?? hasAgentCatalogRefreshedToday)(provider, {
    config: { cwd: params.cwd },
  });
  params.showStatus(
    refreshedToday
      ? `[model] using ${getProviderLabel(provider)} model cache refreshed today`
      : `[model] refreshing ${getProviderLabel(provider)} model cache…`,
  );

  let catalog: Awaited<ReturnType<typeof discoverAgentCatalog>>;
  try {
    catalog = await (params.deps.discoverAgentCatalog ?? discoverAgentCatalog)(provider, {
      config: { cwd: params.cwd },
      ...(refreshedToday ? {} : { forceRefresh: true }),
    });
  } catch (error) {
    throw new Error(formatAgentCatalogRefreshError(provider, error));
  }

  params.showStatus(`[model] choose a ${catalog.label} model`);
  const items = listSelectableModelOptionsFromCatalog(catalog).map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }));
  if (items.length === 0) {
    throw new Error(`${provider} harness did not advertise any models`);
  }

  const model = await params.promptWithInlineSelect<string>({
    title: `Choose a ${catalog.label} model`,
    items,
    initialValue: params.currentSelection?.provider === provider ? params.currentSelection.model : undefined,
    selectedDetailTitle: "Details",
    renderSelectedDetail: (item) => item.description ?? "",
    footer: "↑↓ navigate • enter select • esc cancel",
  });
  if (!model) {
    return undefined;
  }

  return {
    provider,
    model,
  };
}

async function promptToPersistInlineModelSelection(params: {
  selection: DownstreamAgentSelection;
  promptWithInlineSelect: PromptWithInlineSelect;
}): Promise<boolean> {
  const decision = await params.promptWithInlineSelect<"no" | "yes">({
    title: `Make ${params.selection.provider}/${params.selection.model ?? "default"} the default for future runs?`,
    items: [
      {
        value: "no",
        label: "No",
        description: "Keep this model change in the current session only",
      },
      {
        value: "yes",
        label: "Yes",
        description: "Persist this choice for future nanoboss runs",
      },
    ],
    initialValue: "no",
    selectedDetailTitle: "Choice",
    renderSelectedDetail: (item) => item.description ?? "",
    footer: "↑↓ choose • enter confirm • esc keep No",
    maxVisible: 4,
  });

  return decision === "yes";
}
