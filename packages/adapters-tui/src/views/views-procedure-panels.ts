import { Container, Spacer, type Component } from "../shared/pi-tui.ts";
import type { UiProcedurePanel, UiState, UiTurn } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import { getPanelRenderer } from "../core/panel-renderers.ts";
import { MessageCardComponent } from "../components/message-card.ts";

export class ProcedurePanelTranscriptComponent implements Component {
  private readonly container = new Container();

  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly panel: UiProcedurePanel,
    private readonly state: UiState,
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    this.container.clear();
    const rendererEntry = getPanelRenderer(this.panel.rendererId);
    let body: Component | undefined;
    if (rendererEntry && rendererEntry.schema.validate(this.panel.payload)) {
      body = rendererEntry.render({
        payload: this.panel.payload,
        state: this.state,
        theme: this.theme,
      });
    }
    if (!body) {
      // Compatibility fallback: persisted transcript replay can reference
      // procedure-panel renderers that are no longer installed. Keep the
      // original panel visible instead of dropping historical output.
      const tone = procedurePanelTone(this.panel.severity);
      const text = formatProcedurePanelReplayText(this.panel);
      body = new MessageCardComponent(this.theme, text.split("\n"), tone);
    }
    this.container.addChild(body);
    this.container.addChild(new Spacer(1));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }
}

function procedurePanelTone(severity: UiProcedurePanel["severity"]): NonNullable<UiTurn["cardTone"]> {
  switch (severity) {
    case "error":
      return "error";
    case "warn":
      return "warning";
    default:
      return "info";
  }
}

function formatProcedurePanelReplayText(panel: UiProcedurePanel): string {
  const payload = panel.payload;
  if (payload && typeof payload === "object") {
    const message = (payload as { message?: unknown }).message;
    const procedure = (payload as { procedure?: unknown }).procedure;
    if (typeof message === "string") {
      return typeof procedure === "string"
        ? `/${procedure}: ${message}`
        : message;
    }
  }
  return `[panel ${panel.rendererId}]`;
}
