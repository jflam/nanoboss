import { Container, type Component } from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import {
  registerChromeContribution,
  type ChromeSlotId,
} from "../core/chrome.ts";
import { getPanelRenderer } from "../core/panel-renderers.ts";

/**
 * Renders any panels registered via ui_panel events whose slot matches
 * this component's slot. Slot-specific contributions are registered
 * below for every non-transcript slot; the transcript slot materializes
 * nb/card@1 panels into turns at the reducer layer.
 */
class PanelsInSlotComponent implements Component {
  private readonly container = new Container();
  private readonly childComponents = new Set<Component>();
  private state: UiState;
  private lastKeys: string[] = [];

  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly slot: ChromeSlotId,
    initialState: UiState,
  ) {
    this.state = initialState;
    this.rebuild();
  }

  setState(state: UiState): void {
    this.state = state;
    this.rebuild();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
    for (const child of this.childComponents) {
      child.invalidate();
    }
  }

  private rebuild(): void {
    const panels = this.state.panels.filter((panel) => panel.slot === this.slot);
    const keys = panels.map((panel) => `${panel.rendererId}::${panel.key ?? ""}`);
    const sameKeys = keys.length === this.lastKeys.length
      && keys.every((key, i) => key === this.lastKeys[i]);
    if (sameKeys && panels.length === this.childComponents.size) {
      return;
    }
    this.lastKeys = keys;
    this.container.clear();
    this.childComponents.clear();
    for (const panel of panels) {
      const renderer = getPanelRenderer(panel.rendererId);
      if (!renderer || !renderer.schema.validate(panel.payload)) {
        continue;
      }
      const component = renderer.render({
        payload: panel.payload,
        state: this.state,
        theme: this.theme,
      });
      this.childComponents.add(component);
      this.container.addChild(component);
    }
  }
}

const PANEL_HOST_SLOTS: ChromeSlotId[] = [
  "header",
  "session",
  "status",
  "transcriptAbove",
  "transcriptBelow",
  "composerAbove",
  "composerBelow",
  "activityBar",
  "overlay",
  "footer",
];

for (const slot of PANEL_HOST_SLOTS) {
  registerChromeContribution({
    id: `core.panels.${slot}`,
    slot,
    order: 1000,
    shouldRender: (state) => state.panels.some((panel) => panel.slot === slot),
    render: ({ getState, theme }) => new PanelsInSlotComponent(theme, slot, getState()),
  });
}
