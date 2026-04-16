import { spawn } from "node:child_process";
import {
  PRE_COMMIT_MARKER_PREFIX,
  type PreCommitPhaseName as PhaseName,
  type PreCommitPhaseResult as PhaseResult,
  type PreCommitPhaseStatus as PhaseStatus,
} from "../procedures/nanoboss/pre-commit-checks-protocol.ts";
import {
  PRE_COMMIT_SKIP_CACHE_WRITE_ENV,
  persistPreCommitChecksRun,
  type CommandExecutionResult,
} from "../procedures/nanoboss/test-cache-lib.ts";

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
    phase: "typecheck:packages",
    argv: ["bun", "run", "--silent", "typecheck:packages"],
  },
  {
    phase: "knip",
    argv: ["bun", "run", "--silent", "knip"],
  },
  {
    phase: "test:packages",
    argv: ["bun", "run", "--silent", "test:packages"],
  },
  {
    phase: "test",
    argv: ["bun", "run", "--silent", "test"],
  },
];

const results: PhaseResult[] = [];
const startedAt = Date.now();
let overallExitCode = 0;
let overallStdout = "";
let overallStderr = "";

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

  const streamLive = current.phase === "test" || current.phase === "test:packages";
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
      writeStdout(chunk);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (streamLive) {
      writeStderr(chunk);
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
  const status: PhaseStatus = exitCode === 0 ? "passed" : "failed";
  overallExitCode = exitCode;

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
    writeStdout(stdout);
  }
  if (!streamLive && stderr.length > 0) {
    writeStderr(stderr);
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

if (process.env[PRE_COMMIT_SKIP_CACHE_WRITE_ENV] !== "1") {
  const result: CommandExecutionResult = {
    exitCode: overallExitCode,
    stdout: overallStdout,
    stderr: overallStderr,
    combinedOutput: `${overallStdout}${overallStderr}`,
    summary: overallExitCode === 0
      ? "Pre-commit checks passed."
      : `Pre-commit checks failed with exit code ${overallExitCode}.`,
    createdAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
  persistPreCommitChecksRun(process.cwd(), result);
}

function emitMarker(payload: object): void {
  writeStdout(`${PRE_COMMIT_MARKER_PREFIX}${JSON.stringify(payload)}\n`);
}

function writeStdout(text: string): void {
  overallStdout += text;
  process.stdout.write(text);
}

function writeStderr(text: string): void {
  overallStderr += text;
  process.stderr.write(text);
}
