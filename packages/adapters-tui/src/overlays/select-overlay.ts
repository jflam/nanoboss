import { Container, SelectList, Spacer, Text, TUI, type Component, type SelectItem } from "../shared/pi-tui.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

export interface SelectOverlayOptions<T extends string> {
  title: string;
  items: Array<SelectItem & { value: T }>;
  footer?: string;
  maxVisible?: number;
  initialValue?: T;
  selectedDetailTitle?: string;
  renderSelectedDetail?: (item: SelectItem & { value: T }) => string;
}

export class SelectOverlay<T extends string> implements Component {
  private readonly container = new Container();
  private readonly selectList: SelectList;
  private readonly selectedDetailText?: Text;

  constructor(
    private readonly tui: TUI,
    private readonly theme: NanobossTuiTheme,
    options: SelectOverlayOptions<T>,
    private readonly done: (value: T | undefined) => void,
  ) {
    this.container.addChild(new Text(theme.accent(options.title)));
    this.container.addChild(new Spacer(1));

    this.selectList = new SelectList(
      options.items,
      Math.min(options.items.length, options.maxVisible ?? 10),
      theme.selectList,
    );
    this.selectList.onSelect = (item) => {
      this.done(item.value as T);
    };
    this.selectList.onCancel = () => {
      this.done(undefined);
    };

    if (options.initialValue) {
      const selectedIndex = options.items.findIndex((item) => item.value === options.initialValue);
      if (selectedIndex >= 0) {
        this.selectList.setSelectedIndex(selectedIndex);
      }
    }

    this.container.addChild(this.selectList);

    if (options.renderSelectedDetail) {
      this.container.addChild(new Spacer(1));
      if (options.selectedDetailTitle) {
        this.container.addChild(new Text(theme.accent(options.selectedDetailTitle)));
      }
      this.selectedDetailText = new Text("", 0, 0);
      this.container.addChild(this.selectedDetailText);
      this.updateSelectedDetail(options, this.selectList.getSelectedItem() as (SelectItem & { value: T }) | null);
      this.selectList.onSelectionChange = (item) => {
        this.updateSelectedDetail(options, item as SelectItem & { value: T });
      };
    }

    if (options.footer) {
      this.container.addChild(new Spacer(1));
      this.container.addChild(new Text(theme.dim(options.footer)));
    }
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
    this.tui.requestRender();
  }

  private updateSelectedDetail(
    options: SelectOverlayOptions<T>,
    item: (SelectItem & { value: T }) | null,
  ): void {
    if (!options.renderSelectedDetail || !this.selectedDetailText) {
      return;
    }

    const text = item ? options.renderSelectedDetail(item) : "";
    this.selectedDetailText.setText(text);
  }
}
