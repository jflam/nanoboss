import type { TuiExtensionContributionCounts } from "@nanoboss/tui-extension-catalog";
import type {
  TuiExtensionContext,
  TuiExtensionLogger,
} from "@nanoboss/tui-extension-sdk";

import type { ActivityBarSegment } from "../core/activity-bar.ts";
import type { KeyBinding } from "../core/bindings.ts";
import type { ChromeContribution } from "../core/chrome.ts";
import type { PanelRenderer } from "../core/panel-renderers.ts";

type TuiExtensionContributionRegistrationMethods = Pick<
  TuiExtensionContext,
  | "registerKeyBinding"
  | "registerChromeContribution"
  | "registerActivityBarSegment"
  | "registerPanelRenderer"
>;

interface TuiExtensionContributionRegistryAdapters {
  registerBinding(binding: KeyBinding): void;
  registerChrome(contribution: ChromeContribution): void;
  registerSegment(segment: ActivityBarSegment): void;
  registerRenderer<T>(renderer: PanelRenderer<T>): void;
  getRenderer(rendererId: string): PanelRenderer | undefined;
  unregisterRenderer(rendererId: string): boolean;
}

interface CreateTuiExtensionContributionRegistrationsParams {
  extensionName: string;
  logger: TuiExtensionLogger;
  adapters: TuiExtensionContributionRegistryAdapters;
  contributionCounts?: Map<string, TuiExtensionContributionCounts>;
}

export function createTuiExtensionContributionRegistrations({
  extensionName,
  logger,
  adapters,
  contributionCounts,
}: CreateTuiExtensionContributionRegistrationsParams): TuiExtensionContributionRegistrationMethods {
  const namespace = (id: string) => `${extensionName}/${id}`;
  const getCounts = (): TuiExtensionContributionCounts | undefined => {
    if (!contributionCounts) return undefined;
    let current = contributionCounts.get(extensionName);
    if (!current) {
      current = {
        bindings: 0,
        chromeContributions: 0,
        activityBarSegments: 0,
        panelRenderers: 0,
      };
      contributionCounts.set(extensionName, current);
    }
    return current;
  };

  return {
    registerKeyBinding(binding) {
      adapters.registerBinding({ ...binding, id: namespace(binding.id) });
      const counts = getCounts();
      if (counts) counts.bindings += 1;
    },
    registerChromeContribution(contribution) {
      adapters.registerChrome({
        ...contribution,
        id: namespace(contribution.id),
      });
      const counts = getCounts();
      if (counts) counts.chromeContributions += 1;
    },
    registerActivityBarSegment(segment) {
      adapters.registerSegment({ ...segment, id: namespace(segment.id) });
      const counts = getCounts();
      if (counts) counts.activityBarSegments += 1;
    },
    registerPanelRenderer(renderer) {
      // Panel rendererIds are NOT namespaced by extension name because they
      // are the public contract a procedure targets via ui.panel().
      if (adapters.getRenderer(renderer.rendererId)) {
        logger.warning(
          `panel renderer "${renderer.rendererId}" shadows a previously-registered renderer`,
        );
        adapters.unregisterRenderer(renderer.rendererId);
      }
      adapters.registerRenderer(renderer);
      const counts = getCounts();
      if (counts) counts.panelRenderers += 1;
    },
  };
}
