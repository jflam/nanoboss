import {
  Spacer,
} from "../shared/pi-tui.ts";
import { registerChromeContribution } from "./chrome.ts";
import { createActivityBarComponent } from "./core-chrome-activity.ts";
import {
  createFooterComponent,
  createHeaderComponent,
  createSessionComponent,
  createStatusComponent,
} from "./core-chrome-components.ts";

/**
 * Core chrome contributions shipped with @nanoboss/adapters-tui. Registered
 * for side effects when this module is imported. Each contribution is a
 * thin wrapper around the lines and components previously hard-wired into
 * NanobossAppView.
 *
 * The composer slot is intentionally NOT registered here: it is owned per
 * NanobossAppView instance (so that the editor can be swapped for inline
 * overlays via showComposer/showEditor without touching the global
 * registry).
 */

registerChromeContribution({
  id: "core.header",
  slot: "header",
  order: 0,
  render: ({ getState, theme }) => createHeaderComponent(theme, getState),
});

registerChromeContribution({
  id: "core.session",
  slot: "session",
  order: 0,
  render: ({ getState, theme }) => createSessionComponent(theme, getState),
});

registerChromeContribution({
  id: "core.status",
  slot: "status",
  order: 0,
  render: ({ getState, theme }) => createStatusComponent(theme, getState),
});

registerChromeContribution({
  id: "core.transcriptAbove.spacer",
  slot: "transcriptAbove",
  order: 0,
  render: () => new Spacer(1),
});

registerChromeContribution({
  id: "core.composerBelow.spacer",
  slot: "composerBelow",
  order: 0,
  render: () => new Spacer(1),
});

registerChromeContribution({
  id: "core.activityBar",
  slot: "activityBar",
  order: 0,
  render: ({ getState, getNowMs, theme }) => createActivityBarComponent(theme, getState, getNowMs),
});

registerChromeContribution({
  id: "core.footer",
  slot: "footer",
  order: 0,
  render: ({ getState, theme }) => createFooterComponent(theme, getState),
});
