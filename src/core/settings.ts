import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseRequiredDownstreamAgentSelection } from "./downstream-agent-selection.ts";
import { formatErrorMessage } from "./error-format.ts";
import type { DownstreamAgentSelection } from "./types.ts";

export interface NanobossSettings {
  defaultAgentSelection?: DownstreamAgentSelection;
  updatedAt?: string;
}

export function getNanobossSettingsPath(): string {
  return join(getNanobossHome(), "settings.json");
}

export function readNanobossSettings(): NanobossSettings | undefined {
  const path = getNanobossSettingsPath();
  if (!existsSync(path)) {
    return undefined;
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to read nanoboss settings at ${path}: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }

  return {
    defaultAgentSelection: raw.defaultAgentSelection === undefined
      ? undefined
      : parseRequiredDownstreamAgentSelection(raw.defaultAgentSelection),
    updatedAt: asNonEmptyString(raw.updatedAt),
  };
}

export function readPersistedDefaultAgentSelection(): DownstreamAgentSelection | undefined {
  return readNanobossSettings()?.defaultAgentSelection;
}

export function writePersistedDefaultAgentSelection(selection: DownstreamAgentSelection): void {
  mkdirSync(getNanobossHome(), { recursive: true });
  writeFileSync(
    getNanobossSettingsPath(),
    `${JSON.stringify({
      defaultAgentSelection: selection,
      updatedAt: new Date().toISOString(),
    } satisfies NanobossSettings, null, 2)}\n`,
    "utf8",
  );
}

function getNanobossHome(): string {
  return join(process.env.HOME?.trim() || homedir(), ".nanoboss");
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
