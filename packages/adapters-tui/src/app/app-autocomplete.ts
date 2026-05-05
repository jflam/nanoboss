import {
  type AutocompleteItem,
  CombinedAutocompleteProvider,
} from "../shared/pi-tui.ts";
import type { EditorLike } from "./app-types.ts";
import type { UiState } from "../state/state.ts";

export class AppAutocompleteSync {
  private signature = "";

  constructor(
    private readonly deps: {
      editor: EditorLike;
      cwd: string;
    },
  ) {}

  refresh(state: UiState): void {
    const signature = state.availableCommands.join("\n");
    if (signature === this.signature) {
      return;
    }

    this.signature = signature;
    this.deps.editor.setAutocompleteProvider(
      new NanobossAutocompleteProvider(
        state.availableCommands.map((command) => ({
          value: command.startsWith("/") ? command.slice(1) : command,
          label: command,
        })),
        this.deps.cwd,
      ),
    );
  }
}

class NanobossAutocompleteProvider extends CombinedAutocompleteProvider {
  override applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  } {
    if (prefix.startsWith("/")) {
      const currentLine = lines[cursorLine] ?? "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      if (beforePrefix.trim() === "") {
        const completedLines = [...lines];
        completedLines[cursorLine] = `${beforePrefix}/${item.value} ${currentLine.slice(cursorCol)}`;
        return {
          lines: completedLines,
          cursorLine,
          cursorCol: beforePrefix.length + item.value.length + 2,
        };
      }
    }

    return super.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}
