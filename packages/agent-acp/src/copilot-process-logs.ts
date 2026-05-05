import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function findCopilotProcessLogs(logsDir: string, childPid: number | undefined): string[] {
  if (!childPid || !existsSync(logsDir)) {
    return [];
  }

  const entries = readdirSync(logsDir);
  const candidatePids = collectCopilotProcessFamilyPids(childPid);
  const exactMatches = findCopilotLogsForPids(logsDir, candidatePids, entries);
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return findMostRecentCopilotLogs(logsDir, entries, 8);
}

function findCopilotLogsForPids(
  dir: string,
  pids: number[],
  entries: string[] = readdirSync(dir),
): string[] {
  const suffixes = new Set(pids.map((pid) => `-${pid}.log`));
  return entries
    .filter((entry) => {
      for (const suffix of suffixes) {
        if (entry.endsWith(suffix)) {
          return true;
        }
      }
      return false;
    })
    .map((entry) => join(dir, entry))
    .sort((left, right) => right.localeCompare(left));
}

function collectCopilotProcessFamilyPids(rootPid: number): number[] {
  const psOutput = readPsOutput();
  return psOutput ? [rootPid, ...parseDescendantPidsFromPsOutput(psOutput, rootPid)] : [rootPid];
}

function parseDescendantPidsFromPsOutput(psOutput: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();

  for (const line of psOutput.split(/\n+/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }

  const descendants: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();

  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }

    seen.add(pid);
    descendants.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }

  return descendants;
}

function readPsOutput(): string | undefined {
  try {
    const result = Bun.spawnSync({
      cmd: ["ps", "-ax", "-o", "pid=,ppid=,command="],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      return undefined;
    }

    return new TextDecoder().decode(result.stdout);
  } catch {
    return undefined;
  }
}

function findMostRecentCopilotLogs(dir: string, entries: string[], limit: number): string[] {
  return entries
    .filter((entry) => entry.startsWith("process-") && entry.endsWith(".log"))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, limit)
    .map((entry) => join(dir, entry));
}
