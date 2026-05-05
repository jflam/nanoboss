import {
  type TuiExtensionContextFactory,
  type TuiExtensionContributionCounts,
  type TuiExtensionRegistry,
} from "@nanoboss/tui-extension-catalog";

import {
  createTuiExtensionContextFactory,
  type TuiExtensionBootLog,
  type TuiExtensionContextFactoryDeps,
} from "./boot-extension-context.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

interface ActivateTuiExtensionRegistryParams {
  registry: TuiExtensionRegistry;
  theme: NanobossTuiTheme;
  log: TuiExtensionBootLog;
  contextFactory?: TuiExtensionContextFactory;
  contextFactoryDeps?: TuiExtensionContextFactoryDeps;
}

interface TuiExtensionActivationSummary {
  failedCount: number;
  aggregateStatus?: string;
}

export async function activateTuiExtensionRegistry({
  registry,
  theme,
  log,
  contextFactory,
  contextFactoryDeps,
}: ActivateTuiExtensionRegistryParams): Promise<TuiExtensionActivationSummary> {
  const contributionCounts = new Map<string, TuiExtensionContributionCounts>();
  const factory = contextFactory
    ?? createTuiExtensionContextFactory(theme, log, contextFactoryDeps, contributionCounts);

  await registry.activateAll(factory);

  // Forward captured contribution counts into the registry so the
  // `/extensions` slash command (and anyone else calling listMetadata)
  // sees what each extension registered during activate().
  if (!contextFactory) {
    for (const [name, counts] of contributionCounts) {
      registry.setContributions(name, counts);
    }
  }

  const failedCount = registry
    .listMetadata()
    .filter((entry) => entry.status === "failed").length;

  if (failedCount === 0) {
    return { failedCount };
  }

  const plural = failedCount === 1 ? "" : "s";
  const aggregateStatus = `[extensions] ${failedCount} extension${plural} failed to activate`;
  log("error", aggregateStatus);
  return { failedCount, aggregateStatus };
}
