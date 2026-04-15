import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DownstreamAgentSelection } from "@nanoboss/contracts";

export function writePersistedDefaultAgentSelection(selection: DownstreamAgentSelection): void {
  mkdirSync(getNanobossHome(), { recursive: true });
  writeFileSync(
    join(getNanobossHome(), "settings.json"),
    `${JSON.stringify({
      defaultAgentSelection: selection,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
}

function getNanobossHome(): string {
  return join(process.env.HOME?.trim() || homedir(), ".nanoboss");
}
