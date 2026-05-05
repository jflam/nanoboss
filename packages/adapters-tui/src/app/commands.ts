import type { AutocompleteItem } from "../shared/pi-tui.ts";

import {
  isKnownAgentProvider,
} from "@nanoboss/agent-acp";
import type { DownstreamAgentSelection } from "@nanoboss/contracts";
import type { UiInputDisabledReason } from "../state/state.ts";
import type { ToolCardThemeMode } from "../theme/theme.ts";

export const LOCAL_TUI_COMMANDS = [
  { name: "/new", description: "Start a new session" },
  { name: "/end", description: "Exit the interactive frontend" },
  { name: "/quit", description: "Exit the interactive frontend" },
  { name: "/exit", description: "Exit the interactive frontend" },
  { name: "/model", description: "Pick or change the downstream model" },
  { name: "/extensions", description: "List loaded TUI extensions" },
  { name: "/dark", description: "Use dark tool card backgrounds" },
  { name: "/light", description: "Use light tool card backgrounds" },
] as const;

function toLocalAutocompleteItems(): AutocompleteItem[] {
  return LOCAL_TUI_COMMANDS.map((command) => ({
    value: command.name,
    label: command.name,
    description: command.description,
  }));
}

export function isExitRequest(trimmed: string): boolean {
  return trimmed === "exit" || trimmed === "quit" || trimmed === "/end" || trimmed === "/quit" || trimmed === "/exit";
}

export function shouldDisableEditorSubmit(
  inputDisabled: boolean,
  inputDisabledReason: UiInputDisabledReason | undefined,
  text: string,
): boolean {
  if (!inputDisabled) {
    return false;
  }

  if (inputDisabledReason === "local") {
    return true;
  }

  return text.trim().length === 0;
}

export function isNewSessionRequest(trimmed: string): boolean {
  return trimmed === "/new";
}

export function isModelPickerRequest(trimmed: string): boolean {
  return trimmed === "/model";
}

export function isExtensionsListRequest(trimmed: string): boolean {
  return trimmed === "/extensions";
}

export function parseToolCardThemeCommand(trimmed: string): ToolCardThemeMode | undefined {
  if (trimmed === "/dark") {
    return "dark";
  }

  if (trimmed === "/light") {
    return "light";
  }

  return undefined;
}

export function parseModelSelectionCommand(line: string): DownstreamAgentSelection | undefined {
  if (!line.startsWith("/model ")) {
    return undefined;
  }

  const [, rawProvider, ...rest] = line.split(/\s+/);
  if (!rawProvider || !isKnownAgentProvider(rawProvider)) {
    return undefined;
  }

  const model = rest.join(" ").trim();
  if (!model) {
    return undefined;
  }

  return {
    provider: rawProvider,
    model,
  };
}
