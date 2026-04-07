import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  executeAutoresearchClearCommand,
  executeAutoresearchCommand,
  executeAutoresearchFinalizeCommand,
  executeAutoresearchLoopCommand,
  executeAutoresearchStopCommand,
  type AutoresearchRuntime,
} from "../../src/autoresearch/runner.ts";
import { readExperimentLog } from "../../src/autoresearch/log.ts";
import { resolveAutoresearchPaths, readAutoresearchState } from "../../src/autoresearch/state.ts";
import type {
  AutoresearchApplyResult,
  AutoresearchExperimentSpec,
  AutoresearchInitPlan,
} from "../../src/autoresearch/types.ts";
import type { CommandContext, DownstreamAgentConfig, RunResult } from "../../src/core/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("autoresearch procedures", () => {
  test("initializes repo-local state and baseline log on first run", async () => {
    const cwd = createFixtureRepo();
    const runtime = createFakeRuntime();
    const initPlan = buildInitPlan();
    const result = await executeAutoresearchCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async () => initPlan),
      runtime.runtime,
    );

    const paths = resolveAutoresearchPaths(cwd);
    const state = readAutoresearchState(paths);
    const records = readExperimentLog(paths);

    expect(state).toBeDefined();
    expect(state?.goal).toBe("reduce the score benchmark");
    expect(state?.branchName).toContain("autoresearch/");
    expect(state?.currentBestMetric).toBe(100);
    expect(records).toHaveLength(1);
    expect(records[0]?.decision.status).toBe("baseline");
    expect(records[0]?.benchmark.metric).toBe(100);
    expect(runtime.started).toHaveLength(1);
    expect(getCurrentBranch(cwd)).toBe(state?.branchName);
    expect((result.data as { dispatchId: string }).dispatchId).toBe("dispatch-1");
  });

  test("resumes from existing state without reinitializing", async () => {
    const cwd = createFixtureRepo();
    const runtime = createFakeRuntime();
    await executeAutoresearchCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async () => buildInitPlan()),
      runtime.runtime,
    );

    runtime.statuses.delete("dispatch-1");
    const resumed = await executeAutoresearchCommand(
      "resume keep focusing on score.txt",
      createMockContext(cwd, async () => {
        throw new Error("callAgent should not be used when state already exists");
      }),
      runtime.runtime,
    );

    const state = readAutoresearchState(resolveAutoresearchPaths(cwd));
    expect(runtime.started).toHaveLength(2);
    expect(state?.pendingContextNotes).toContain("keep focusing on score.txt");
    expect((resumed.data as { dispatchId: string }).dispatchId).toBe("dispatch-2");
  });

  test("keeps improved experiments, rejects regressions, and records confidence", async () => {
    const cwd = createFixtureRepo();
    const runtime = createFakeRuntime();
    await executeAutoresearchCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async () => buildInitPlan()),
      runtime.runtime,
    );

    const keepSpec: AutoresearchExperimentSpec = {
      idea: "Lower the score",
      rationale: "Reduce the score value directly",
      filesInScope: ["score.txt"],
      editInstructions: "Write 90 to score.txt",
      expectedMetricEffect: "score drops from 100 to 90",
      commitMessage: "autoresearch: lower score",
    };
    const keepApply: AutoresearchApplyResult = {
      summary: "Wrote 90 to score.txt",
      touchedFiles: ["score.txt"],
    };
    await executeAutoresearchLoopCommand(
      "",
      createMockContext(cwd, async (prompt, callCount) => {
        if (callCount === 1) {
          expect(prompt).toContain("choosing the next experiment");
          return keepSpec;
        }
        writeFileSync(join(cwd, "score.txt"), "90\n", "utf8");
        return keepApply;
      }),
      runtime.runtime,
    );

    const rejectSpec: AutoresearchExperimentSpec = {
      idea: "Increase the score",
      rationale: "Test a regression path",
      filesInScope: ["score.txt"],
      editInstructions: "Write 120 to score.txt",
      expectedMetricEffect: "score rises from 90 to 120",
      commitMessage: "autoresearch: increase score",
    };
    const rejectApply: AutoresearchApplyResult = {
      summary: "Wrote 120 to score.txt",
      touchedFiles: ["score.txt"],
    };
    await executeAutoresearchLoopCommand(
      "",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return rejectSpec;
        }
        writeFileSync(join(cwd, "score.txt"), "120\n", "utf8");
        return rejectApply;
      }),
      runtime.runtime,
    );

    const paths = resolveAutoresearchPaths(cwd);
    const state = readAutoresearchState(paths);
    const records = readExperimentLog(paths);

    expect(readFileSync(join(cwd, "score.txt"), "utf8")).toBe("90\n");
    expect(getCommitCount(cwd)).toBe(2);
    expect(records.map((record) => record.decision.status)).toEqual(["baseline", "kept", "rejected"]);
    expect(records[2]?.confidence?.sampleCount).toBe(3);
    expect(state?.currentBestMetric).toBe(90);
  });

  test("treats failing checks as failed experiments and reverts the candidate change", async () => {
    const cwd = createFixtureRepo();
    const runtime = createFakeRuntime();
    writeFileSync(join(cwd, "gate.txt"), "pass\n", "utf8");
    execFileSync("git", ["add", "gate.txt"], { cwd, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add gate fixture"], { cwd, stdio: "pipe" });
    await executeAutoresearchCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async () => buildInitPlan({
        filesInScope: ["score.txt", "gate.txt"],
        checks: [
          {
            name: "smoke",
            argv: [
              "bun",
              "-e",
              "import { readFileSync } from 'node:fs'; process.exit(readFileSync('gate.txt', 'utf8').trim() === 'pass' ? 0 : 2)",
            ],
          },
        ],
      })),
      runtime.runtime,
    );

    await executeAutoresearchLoopCommand(
      "",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return {
            idea: "Lower the score",
            rationale: "Reduce the score value directly",
            filesInScope: ["score.txt", "gate.txt"],
            editInstructions: "Write 80 to score.txt and fail the smoke gate",
          } satisfies AutoresearchExperimentSpec;
        }
        writeFileSync(join(cwd, "score.txt"), "80\n", "utf8");
        writeFileSync(join(cwd, "gate.txt"), "fail\n", "utf8");
        return {
          summary: "Wrote 80 to score.txt and failed gate.txt",
          touchedFiles: ["score.txt", "gate.txt"],
        } satisfies AutoresearchApplyResult;
      }),
      runtime.runtime,
    );

    const records = readExperimentLog(resolveAutoresearchPaths(cwd));
    expect(records[1]?.decision.status).toBe("failed");
    expect(records[1]?.decision.reason).toContain("Check failed: smoke");
    expect(readFileSync(join(cwd, "score.txt"), "utf8")).toBe("100\n");
    expect(readFileSync(join(cwd, "gate.txt"), "utf8")).toBe("pass\n");
    expect(getCommitCount(cwd)).toBe(2);
  });

  test("stop preserves history and clear removes repo-local state", async () => {
    const cwd = createFixtureRepo();
    const runtime = createFakeRuntime();
    await executeAutoresearchCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async () => buildInitPlan()),
      runtime.runtime,
    );

    await executeAutoresearchStopCommand("", createMockContext(cwd, async () => {
      throw new Error("stop does not use callAgent");
    }), runtime.runtime);

    const paths = resolveAutoresearchPaths(cwd);
    expect(readAutoresearchState(paths)?.status).toBe("inactive");
    expect(readExperimentLog(paths)).toHaveLength(1);
    expect(runtime.cancelled).toHaveLength(1);

    await executeAutoresearchClearCommand("", createMockContext(cwd, async () => {
      throw new Error("clear does not use callAgent");
    }));

    expect(readAutoresearchState(paths)).toBeUndefined();
    expect(() => readFileSync(paths.logPath, "utf8")).toThrow();
  });

  test("finalize creates review branches for kept experiment commits", async () => {
    const cwd = createFixtureRepo();
    const runtime = createFakeRuntime();
    await executeAutoresearchCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async () => buildInitPlan()),
      runtime.runtime,
    );

    await executeAutoresearchLoopCommand(
      "",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return {
            idea: "Lower the score",
            rationale: "Reduce the score value directly",
            filesInScope: ["score.txt"],
            editInstructions: "Write 90 to score.txt",
            commitMessage: "autoresearch: lower score",
          } satisfies AutoresearchExperimentSpec;
        }
        writeFileSync(join(cwd, "score.txt"), "90\n", "utf8");
        return {
          summary: "Wrote 90 to score.txt",
          touchedFiles: ["score.txt"],
        } satisfies AutoresearchApplyResult;
      }),
      runtime.runtime,
    );

    await executeAutoresearchStopCommand("", createMockContext(cwd, async () => {
      throw new Error("stop does not use callAgent");
    }), runtime.runtime);

    const branchBeforeFinalize = getCurrentBranch(cwd);
    const result = await executeAutoresearchFinalizeCommand(
      "",
      createMockContext(cwd, async () => {
        throw new Error("finalize does not use callAgent");
      }),
    );

    const createdBranch = ((result.data as { branches: Array<{ branchName: string }> }).branches[0])?.branchName;
    expect(createdBranch).toBeDefined();
    expect(readGitFile(cwd, createdBranch as string, "score.txt")).toBe("90");
    expect(getCurrentBranch(cwd)).toBe(branchBeforeFinalize);
  });

  test("reports command-specific guidance when no autoresearch session exists", async () => {
    const cwd = createFixtureRepo();
    const runtime = createFakeRuntime();
    const ctx = createMockContext(cwd, async () => {
      throw new Error("missing-state commands should not callAgent");
    });

    const status = await executeAutoresearchCommand("status", ctx, runtime.runtime);
    const loop = await executeAutoresearchLoopCommand("", ctx, runtime.runtime);
    const stop = await executeAutoresearchStopCommand("", ctx, runtime.runtime);
    const clear = await executeAutoresearchClearCommand("", ctx);
    const finalize = await executeAutoresearchFinalizeCommand("", ctx);

    expect(status.display).toBe(
      "No autoresearch session exists in this repository yet. Run /autoresearch <goal> to start one.\n",
    );
    expect(loop.display).toBe(
      "Cannot continue autoresearch: no session exists in this repository yet. Run /autoresearch <goal> to start one.\n",
    );
    expect(stop.display).toBe("Cannot stop autoresearch: no session exists in this repository yet.\n");
    expect(clear.display).toBe("Cannot clear autoresearch: no session exists in this repository yet.\n");
    expect(finalize.display).toBe("Cannot finalize autoresearch: no session exists in this repository yet.\n");
  });
});

function buildInitPlan(overrides: Partial<AutoresearchInitPlan> = {}): AutoresearchInitPlan {
  return {
    goalSummary: "reduce score",
    branchName: "autoresearch/reduce-score",
    filesInScope: ["score.txt"],
    maxIterations: 3,
    benchmark: {
      argv: [
        "bun",
        "-e",
        "import { readFileSync } from 'node:fs'; console.log('score=' + readFileSync('score.txt', 'utf8').trim())",
      ],
      metric: {
        name: "score",
        direction: "lower",
        source: "stdout-regex",
        pattern: "score=(\\d+(?:\\.\\d+)?)",
      },
    },
    checks: [],
    ...overrides,
  };
}

function createFixtureRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "nab-autoresearch-"));
  tempDirs.push(cwd);
  writeFileSync(join(cwd, "score.txt"), "100\n", "utf8");

  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "nanoboss test"], { cwd, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "nanoboss@example.com"], { cwd, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "Initial fixture"], { cwd, stdio: "pipe" });

  return cwd;
}

function createMockContext(
  cwd: string,
  handler: (prompt: string, callCount: number) => Promise<unknown>,
): CommandContext {
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "copilot",
    command: "copilot",
    args: [],
    cwd,
  };
  let callCount = 0;

  return {
    cwd,
    sessionId: "test-session",
    refs: {
      async read() {
        throw new Error("Not implemented in test");
      },
      async stat() {
        throw new Error("Not implemented in test");
      },
      async writeToFile() {
        throw new Error("Not implemented in test");
      },
    },
    session: {
      async recent() {
        return [];
      },
      async topLevelRuns() {
        return [];
      },
      async get() {
        throw new Error("Not implemented in test");
      },
      async ancestors() {
        return [];
      },
      async descendants() {
        return [];
      },
    },
    getDefaultAgentConfig() {
      return defaultAgentConfig;
    },
    setDefaultAgentSelection() {
      return defaultAgentConfig;
    },
    async getDefaultAgentTokenSnapshot() {
      return undefined;
    },
    async getDefaultAgentTokenUsage() {
      return undefined;
    },
    callAgent: (async (prompt: string) => {
      callCount += 1;
      return {
        cell: {
          sessionId: "test-session",
          cellId: `agent-${callCount}`,
        },
        data: await handler(prompt, callCount),
      } as RunResult<unknown>;
    }) as CommandContext["callAgent"],
    async callProcedure() {
      throw new Error("Not implemented in test");
    },
    async continueDefaultSession() {
      throw new Error("Not implemented in test");
    },
    print() {},
  };
}

function createFakeRuntime(): {
  runtime: AutoresearchRuntime;
  started: Array<{ dispatchId: string; correlationId: string }>;
  cancelled: string[];
  statuses: Map<string, ReturnType<AutoresearchRuntime["getLoopDispatchStatus"]> extends Promise<infer T> ? T : never>;
} {
  const started: Array<{ dispatchId: string; correlationId: string }> = [];
  const cancelled: string[] = [];
  const statuses = new Map<string, ProcedureStatus>();
  let nextDispatchId = 1;

  return {
    runtime: {
      async startLoopDispatch({ correlationId }) {
        const dispatchId = `dispatch-${nextDispatchId++}`;
        const status: ProcedureStatus = {
          dispatchId,
          status: "queued",
          procedure: "autoresearch-loop",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        started.push({ dispatchId, correlationId });
        statuses.set(dispatchId, status);
        return {
          dispatchId,
          status: "queued",
        };
      },
      async getLoopDispatchStatus({ dispatchId }) {
        return statuses.get(dispatchId);
      },
      cancelLoopDispatch({ correlationId }) {
        cancelled.push(correlationId);
      },
    },
    started,
    cancelled,
    statuses,
  };
}

type ProcedureStatus = {
  dispatchId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  procedure: string;
  createdAt: string;
  updatedAt: string;
};

function getCurrentBranch(cwd: string): string {
  return execFileSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function getCommitCount(cwd: string): number {
  return Number.parseInt(execFileSync("git", ["rev-list", "--count", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim(), 10);
}

function readGitFile(cwd: string, ref: string, path: string): string {
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd,
    encoding: "utf8",
  }).trim();
}
