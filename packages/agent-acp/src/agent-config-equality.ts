import type { DownstreamAgentConfig } from "./types.ts";

export function sameAgentConfig(left: DownstreamAgentConfig, right: DownstreamAgentConfig): boolean {
  return (
    left.provider === right.provider &&
    left.command === right.command &&
    left.cwd === right.cwd &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    sameStringArray(left.args, right.args) &&
    sameStringRecord(left.env, right.env)
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringRecord(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value], index) => {
      const rightEntry = rightEntries[index];
      return rightEntry !== undefined && key === rightEntry[0] && value === rightEntry[1];
    })
  );
}
