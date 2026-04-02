import {
  findSelectableModelOption,
  getProviderLabel,
  isKnownAgentProvider,
  isKnownModelSelection,
  listKnownProviders,
  listSelectableModelOptions,
} from "../src/model-catalog.ts";
import { formatAgentBanner } from "../src/runtime-banner.ts";
import type { Procedure } from "../src/types.ts";

export default {
  name: "model",
  description: "Set or inspect the default agent/model for this session",
  inputHint: "[agent] [model]",
  async execute(prompt, ctx) {
    const trimmed = prompt.trim();
    const current = ctx.getDefaultAgentConfig();
    const currentBanner = formatAgentBanner(current);

    if (!trimmed) {
      const snapshot = await ctx.getDefaultAgentTokenSnapshot();
      const contextLine = formatObservedContext(snapshot);

      return {
        display: [
          `Current default agent: ${currentBanner}`,
          contextLine,
          contextLine ? `Context source: ${snapshot?.source}` : undefined,
          contextLine ? "" : undefined,
          "Use `/model <agent>` to list models.",
          "Use `/model <agent> <model>` to switch.",
          "In the TTY CLI, plain `/model` opens an interactive picker.",
          "",
          "Available agents:",
          ...listKnownProviders().map((provider) => `- ${provider} (${getProviderLabel(provider)})`),
          "",
        ].filter(Boolean).join("\n"),
        summary: contextLine ? `model: ${currentBanner} ${contextLine}` : `model: ${currentBanner}`,
      };
    }

    const [rawProvider, ...rest] = trimmed.split(/\s+/);
    if (!rawProvider || !isKnownAgentProvider(rawProvider)) {
      return {
        display: [
          `Unknown agent: ${rawProvider ?? trimmed}`,
          "",
          "Known agents:",
          ...listKnownProviders().map((provider) => `- ${provider}`),
          "",
        ].join("\n"),
        summary: "model: unknown agent",
      };
    }

    if (rest.length === 0) {
      const models = listSelectableModelOptions(rawProvider);
      return {
        display: [
          `Models for ${getProviderLabel(rawProvider)}:`,
          ...models.map((model) => {
            const suffix = model.description ? ` — ${model.description}` : "";
            return `- ${model.value}${suffix}`;
          }),
          "",
          `Use \`/model ${rawProvider} <model>\` to switch.`,
          "",
        ].join("\n"),
        summary: `model: list ${rawProvider}`,
      };
    }

    const modelSelection = rest.join(" ").trim();
    if (!isKnownModelSelection(rawProvider, modelSelection)) {
      return {
        display: [
          `Unknown ${rawProvider} model: ${modelSelection}`,
          "",
          `Use \`/model ${rawProvider}\` to see the available models.`,
          "",
        ].join("\n"),
        summary: `model: invalid ${rawProvider}`,
      };
    }

    const nextConfig = ctx.setDefaultAgentSelection({
      provider: rawProvider,
      model: modelSelection,
    });
    const option = findSelectableModelOption(rawProvider, modelSelection);
    const nextBanner = formatAgentBanner(nextConfig);

    return {
      data: {
        provider: rawProvider,
        model: modelSelection,
      },
      display: [
        `Default agent set to ${nextBanner}.`,
        option?.description ? `Model: ${option.label}` : undefined,
        "Future /default turns will start a fresh conversation with this selection.",
        "",
      ].filter(Boolean).join("\n"),
      summary: `model: ${nextBanner}`,
    };
  },
} satisfies Procedure;

function formatObservedContext(snapshot: { usedContextTokens?: number; contextWindowTokens?: number } | undefined): string | undefined {
  if (!snapshot || snapshot.usedContextTokens === undefined) {
    return undefined;
  }

  if (snapshot.contextWindowTokens === undefined) {
    return `Last observed context: ${formatInt(snapshot.usedContextTokens)} tokens in use`;
  }

  return `Last observed context: ${formatInt(snapshot.usedContextTokens)} / ${formatInt(snapshot.contextWindowTokens)} tokens (${formatPercent(snapshot.usedContextTokens, snapshot.contextWindowTokens)})`;
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(used: number, total: number): string {
  if (total <= 0) {
    return "0.0%";
  }

  return `${((used / total) * 100).toFixed(1)}%`;
}
