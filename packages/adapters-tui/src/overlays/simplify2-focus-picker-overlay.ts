import {
  Container,
  SelectList,
  Spacer,
  Text,
  type Component,
  type SelectItem,
  type TUI,
} from "../shared/pi-tui.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

export interface Simplify2FocusPickerEntry {
  id: string;
  title: string;
  subtitle?: string;
  status: "active" | "paused" | "finished" | "archived";
  updatedAt: string;
  lastSummary?: string;
}

type Simplify2FocusPickerOverlayAction =
  | { kind: "continue"; focusId: string }
  | { kind: "archive"; focusId: string }
  | { kind: "new" }
  | { kind: "cancel" };

export class Simplify2FocusPickerOverlay implements Component {
  private readonly container = new Container();
  private readonly selectList: SelectList;

  constructor(
    private readonly tui: TUI,
    private readonly theme: NanobossTuiTheme,
    title: string,
    entries: Simplify2FocusPickerEntry[],
    private readonly done: (action: Simplify2FocusPickerOverlayAction) => void,
  ) {
    this.container.addChild(new Text(this.theme.accent(title)));
    this.container.addChild(new Spacer(1));

    const items: Array<SelectItem & { value: string }> = entries.length === 0
      ? [{ value: "__new__", label: "No saved focuses yet", description: "Press n to create one." }]
      : entries.map((entry) => ({
          value: entry.id,
          label: `${entry.title} [${entry.status}]`,
          description: entry.lastSummary ?? `Updated ${entry.updatedAt}`,
        }));
    this.selectList = new SelectList(items, Math.min(items.length, 8), theme.selectList);
    this.selectList.onSelect = (item) => {
      if (item.value === "__new__") {
        this.done({ kind: "new" });
        return;
      }
      this.done({ kind: "continue", focusId: item.value as string });
    };
    this.selectList.onCancel = () => {
      this.done({ kind: "cancel" });
    };
    this.container.addChild(this.selectList);

    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.theme.dim("Enter continue • d archive • n new • esc cancel")));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    if (data === "n" || data === "N") {
      this.done({ kind: "new" });
      this.tui.requestRender(true);
      return;
    }

    if (data === "d" || data === "D") {
      const selected = this.selectList.getSelectedItem() as (SelectItem & { value: string }) | null;
      if (selected && selected.value !== "__new__") {
        this.done({ kind: "archive", focusId: selected.value });
        this.tui.requestRender(true);
      }
      return;
    }

    this.selectList.handleInput(data);
    this.tui.requestRender();
  }
}
