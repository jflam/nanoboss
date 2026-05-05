import {
  type TuiExtensionContextFactory,
  type TuiExtensionContributionCounts,
} from "@nanoboss/tui-extension-catalog";
import type {
  TuiExtensionContext,
  TuiExtensionLogger,
} from "@nanoboss/tui-extension-sdk";

import {
  registerActivityBarSegment as defaultRegisterActivityBarSegment,
  type ActivityBarSegment,
} from "./activity-bar.ts";
import {
  registerKeyBinding as defaultRegisterKeyBinding,
  type KeyBinding,
} from "./bindings.ts";
import {
  registerChromeContribution as defaultRegisterChromeContribution,
  type ChromeContribution,
} from "./chrome.ts";
import {
  getPanelRenderer as defaultGetPanelRenderer,
  registerPanelRenderer as defaultRegisterPanelRenderer,
  unregisterPanelRenderer as defaultUnregisterPanelRenderer,
  type PanelRenderer,
} from "./panel-renderers.ts";
import type { NanobossTuiTheme } from "./theme.ts";

export type TuiExtensionBootLogLevel = "info" | "warning" | "error";

/**
 * Log router handed to `bootExtensions`. In production the caller forwards
 * these lines to the TUI status-line pathway (`controller.showStatus`). In
 * tests a collector is typically passed so assertions can inspect messages.
 */
export type TuiExtensionBootLog = (
  level: TuiExtensionBootLogLevel,
  text: string,
) => void;

/**
 * Optional dependency overrides for the context factory; surfaced for tests
 * that want to verify namespacing without mutating the real module-level
 * registries.
 */
export interface TuiExtensionContextFactoryDeps {
  registerKeyBinding?: (binding: KeyBinding) => void;
  registerChromeContribution?: (contribution: ChromeContribution) => void;
  registerActivityBarSegment?: (segment: ActivityBarSegment) => void;
  registerPanelRenderer?: <T>(renderer: PanelRenderer<T>) => void;
  getPanelRenderer?: (rendererId: string) => PanelRenderer | undefined;
  unregisterPanelRenderer?: (rendererId: string) => boolean;
}

/**
 * Build a `TuiExtensionContextFactory` that namespaces every contribution id
 * as `${extensionName}/${id}` before delegating to the real adapters-tui
 * registries. The returned factory is what `TuiExtensionRegistry.activateAll`
 * consumes.
 *
 * When `contributionCounts` is supplied the factory increments the matching
 * counter for each `register*` call made through the returned context. The
 * caller can then read the Map after `activateAll` completes (e.g. to
 * forward counts into `TuiExtensionRegistry.setContributions`).
 */
export function createTuiExtensionContextFactory(
  theme: NanobossTuiTheme,
  log: TuiExtensionBootLog,
  deps: TuiExtensionContextFactoryDeps = {},
  contributionCounts?: Map<string, TuiExtensionContributionCounts>,
): TuiExtensionContextFactory {
  const registerBinding = deps.registerKeyBinding ?? defaultRegisterKeyBinding;
  const registerChrome = deps.registerChromeContribution ?? defaultRegisterChromeContribution;
  const registerSegment = deps.registerActivityBarSegment ?? defaultRegisterActivityBarSegment;
  const registerRenderer = deps.registerPanelRenderer ?? defaultRegisterPanelRenderer;
  const getRenderer = deps.getPanelRenderer ?? defaultGetPanelRenderer;
  const unregisterRenderer = deps.unregisterPanelRenderer ?? defaultUnregisterPanelRenderer;

  return ({ metadata, scope }) => {
    const extensionName = metadata.name;
    const namespace = (id: string) => `${extensionName}/${id}`;

    const getCounts = (): TuiExtensionContributionCounts | undefined => {
      if (!contributionCounts) return undefined;
      let current = contributionCounts.get(extensionName);
      if (!current) {
        current = { bindings: 0, chromeContributions: 0, activityBarSegments: 0, panelRenderers: 0 };
        contributionCounts.set(extensionName, current);
      }
      return current;
    };

    const logger: TuiExtensionLogger = {
      info: (text) => { log("info", `[${extensionName}] ${text}`); },
      warning: (text) => { log("warning", `[${extensionName}] ${text}`); },
      error: (text) => { log("error", `[${extensionName}] ${text}`); },
    };

    const context: TuiExtensionContext = {
      extensionName,
      scope,
      theme,
      log: logger,
      registerKeyBinding(binding) {
        registerBinding({ ...binding, id: namespace(binding.id) });
        const counts = getCounts();
        if (counts) counts.bindings += 1;
      },
      registerChromeContribution(contribution) {
        registerChrome({ ...contribution, id: namespace(contribution.id) });
        const counts = getCounts();
        if (counts) counts.chromeContributions += 1;
      },
      registerActivityBarSegment(segment) {
        registerSegment({ ...segment, id: namespace(segment.id) });
        const counts = getCounts();
        if (counts) counts.activityBarSegments += 1;
      },
      registerPanelRenderer(renderer) {
        // Panel rendererIds are NOT namespaced by extension name because they
        // are the public contract a procedure targets via ui.panel().
        if (getRenderer(renderer.rendererId)) {
          logger.warning(
            `panel renderer "${renderer.rendererId}" shadows a previously-registered renderer`,
          );
          unregisterRenderer(renderer.rendererId);
        }
        registerRenderer(renderer);
        const counts = getCounts();
        if (counts) counts.panelRenderers += 1;
      },
    };
    return context;
  };
}
