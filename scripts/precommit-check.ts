import { spawn } from "node:child_process";
import {
  PRE_COMMIT_MARKER_PREFIX,
  type PreCommitPhaseName as PhaseName,
  type PreCommitPhaseResult as PhaseResult,
  type PreCommitPhaseStatus as PhaseStatus,
} from "../procedures/nanoboss/pre-commit-checks-protocol.ts";

const phases: Array<{
  phase: PhaseName;
  argv: string[];
}> = [
  {
    phase: "lint",
    argv: ["bun", "run", "--silent", "lint"],
  },
  {
    phase: "typecheck",
    argv: ["bun", "run", "--silent", "typecheck"],
  },
  {
    phase: "test",
    argv: ["bun", "run", "--silent", "test"],
  },
];

const results: PhaseResult[] = [];

for (let index = 0; index < phases.length; index += 1) {
  const current = phases[index];
  const [command, ...args] = current.argv;

  if (!command) {
    throw new Error(`Missing command for pre-commit phase ${current.phase}`);
  }

  emitMarker({
    type: "phase_start",
    phase: current.phase,
  });

  const streamLive = current.phase === "test";
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (streamLive) {
      process.stdout.write(chunk);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (streamLive) {
      process.stderr.write(chunk);
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
  const status: PhaseStatus = exitCode === 0 ? "passed" : "failed";

  results.push({
    phase: current.phase,
    status,
    exitCode,
  });
  emitMarker({
    type: "phase_result",
    phase: current.phase,
    status,
    exitCode,
  });

  if (!streamLive && stdout.length > 0) {
    process.stdout.write(stdout);
  }
  if (!streamLive && stderr.length > 0) {
    process.stderr.write(stderr);
  }

  if (status === "failed") {
    for (let skippedIndex = index + 1; skippedIndex < phases.length; skippedIndex += 1) {
      const skippedPhase = phases[skippedIndex];
      results.push({
        phase: skippedPhase.phase,
        status: "not_run",
      });
      emitMarker({
        type: "phase_result",
        phase: skippedPhase.phase,
        status: "not_run",
      });
    }
    emitMarker({
      type: "run_result",
      phases: results,
    });
    process.exitCode = exitCode;
    break;
  }

  if (index === phases.length - 1) {
    emitMarker({
      type: "run_result",
      phases: results,
    });
  }
}

function emitMarker(payload: object): void {
  process.stdout.write(`${PRE_COMMIT_MARKER_PREFIX}${JSON.stringify(payload)}\n`);
}
