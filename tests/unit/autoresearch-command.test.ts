import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildProcedureDispatchJobPath,
  isProcedureDispatchCancellationRequested,
  RunCancelledError,
} from "@nanoboss/procedure-engine";
import { getSessionDir } from "@nanoboss/store";
import {
  executeAutoresearchClearCommand,
  executeAutoresearchCommand,
  executeAutoresearchContinueCommand,
  executeAutoresearchFinalizeCommand,
  executeAutoresearchStartCommand,
  executeAutoresearchStatusCommand,
} from "../../procedures/autoresearch/runner.ts";
import { readExperimentLog } from "../../procedures/autoresearch/log.ts";
import {
  readAutoresearchState,
  resolveAutoresearchPaths,
  writeAutoresearchState,
} from "../../procedures/autoresearch/state.ts";
import type {
  AutoresearchApplyResult,
  AutoresearchExperimentSpec,
  AutoresearchInitPlan,
} from "../../procedures/autoresearch/types.ts";
import type { DownstreamAgentConfig, ProcedureApi, RunResult } from "@nanoboss/procedure-sdk";

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
  test("start initializes repo-local state and runs a foreground iteration", async () => {
    const cwd = createFixtureRepo();
    const printed: string[] = [];

    const result = await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (prompt, callCount) => {
        if (callCount === 1) {
          expect(prompt).toContain("return a JSON object matching this schema exactly");
          expect(prompt).toContain("Include `maxIterations` explicitly in the JSON response as a positive integer.");
          return buildInitPlan({ maxIterations: 1 });
        }
        if (callCount === 2) {
          return buildExperimentSpec("Lower the score", "Write 90 to score.txt", "score drops from 100 to 90");
        }

        writeFileSync(join(cwd, "score.txt"), "90\n", "utf8");
        return buildApplyResult("Wrote 90 to score.txt");
      }, printed),
    );

    const paths = resolveAutoresearchPaths(cwd);
    const state = readAutoresearchState(paths);
    const records = readExperimentLog(paths);

    expect(paths.storageDir).toBe(join(paths.repoRoot, ".nanoboss", "autoresearch"));
    expect(state).toBeDefined();
    expect(state?.goal).toBe("reduce the score benchmark");
    expect(state?.status).toBe("inactive");
    expect(state?.branchName).toContain("autoresearch/");
    expect(state?.iterationCount).toBe(1);
    expect(state?.currentBestMetric).toBe(90);
    expect(records.map((record) => record.decision.status)).toEqual(["baseline", "kept"]);
    expect(state?.branchName).toBeDefined();
    if (!state?.branchName) {
      throw new Error("Expected autoresearch branch name");
    }
    expect(getCurrentBranch(cwd)).toBe(state.branchName);
    expect(getCommitCount(cwd)).toBe(2);
    const resultData = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : undefined;
    expect(resultData?.bestMetric).toBe(90);
    expect(resultData?.iterationCount).toBe(1);
    expect(resultData?.maxIterations).toBe(1);
    expect(resultData?.status).toBe("inactive");
    expect(readFileSync(resolveGitPath(cwd, "info/exclude"), "utf8")).toContain("/.nanoboss/");
    expect(printed.join("")).toContain("Configuring autoresearch session...");
    expect(printed.join("")).toContain("Baseline: score -> 100.");
    expect(printed.join("")).toContain("Iteration 1/1: selecting the next experiment.");
    expect(printed.join("")).toContain("Result: 90, improvement kept.");
  });

  test("start falls back to the default maxIterations when the init plan omits it", async () => {
    const cwd = createFixtureRepo();

    const result = await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return {
            goalSummary: "reduce score",
            branchName: "autoresearch/reduce-score",
            filesInScope: ["score.txt"],
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
          };
        }
        if (callCount === 2) {
          return buildStopSpec("nothing useful to try");
        }
        throw new Error("autoresearch start should stop immediately after the fallback budget is applied");
      }),
    );

    const state = readAutoresearchState(resolveAutoresearchPaths(cwd));
    const resultData = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : undefined;

    expect(state?.maxIterations).toBe(10);
    expect(state?.iterationCount).toBe(0);
    expect(resultData?.maxIterations).toBe(10);
    expect(resultData?.iterationCount).toBe(0);
  });

  test("continue resumes from durable state and incorporates continuation notes", async () => {
    const cwd = createFixtureRepo();

    await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return buildInitPlan({ maxIterations: 3 });
        }
        if (callCount === 2) {
          return buildExperimentSpec("Lower the score", "Write 90 to score.txt", "score drops from 100 to 90");
        }
        if (callCount === 3) {
          writeFileSync(join(cwd, "score.txt"), "90\n", "utf8");
          return buildApplyResult("Wrote 90 to score.txt");
        }
        return buildStopSpec("leave room for a later continuation");
      }),
    );

    const printed: string[] = [];
    const continued = await executeAutoresearchContinueCommand(
      "keep focusing on score.txt",
      createMockContext(cwd, async (prompt, callCount) => {
        if (callCount === 1) {
          expect(prompt).toContain("Pending notes:\n- keep focusing on score.txt");
          return buildExperimentSpec("Increase the score", "Write 120 to score.txt", "score rises from 90 to 120");
        }
        if (callCount === 2) {
          writeFileSync(join(cwd, "score.txt"), "120\n", "utf8");
          return buildApplyResult("Wrote 120 to score.txt");
        }
        return buildStopSpec("done for now");
      }, printed),
    );

    const state = readAutoresearchState(resolveAutoresearchPaths(cwd));
    expect(state?.status).toBe("inactive");
    expect(state?.iterationCount).toBe(2);
    expect(state?.currentBestMetric).toBe(90);
    expect(state?.pendingContextNotes).toEqual([]);
    expect(readFileSync(join(cwd, "score.txt"), "utf8")).toBe("90\n");
    const continuedData = continued.data && typeof continued.data === "object"
      ? continued.data as Record<string, unknown>
      : undefined;
    expect(continuedData?.bestMetric).toBe(90);
    expect(continuedData?.iterationCount).toBe(2);
    expect(continuedData?.status).toBe("inactive");
    expect(printed.join("")).toContain("Continuing autoresearch on");
    expect(printed.join("")).toContain("Result: 120, reverted.");
  });

  test("cancellation leaves autoresearch inactive so it can be cleared", async () => {
    const cwd = createFixtureRepo();

    await expect(executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return buildInitPlan({ maxIterations: 2 });
        }

        throw new RunCancelledError("Stopped.", "soft_stop");
      }),
    )).rejects.toThrow("Stopped.");

    const paths = resolveAutoresearchPaths(cwd);
    const state = readAutoresearchState(paths);
    expect(state?.status).toBe("inactive");

    const cleared = await executeAutoresearchClearCommand("", createMockContext(cwd, async () => {
      throw new Error("clear should not callAgent");
    }));
    expect(cleared.summary).toBe("autoresearch/clear: cleared state");
    expect(existsSync(paths.statePath)).toBe(false);
  });

  test("cancellation after benchmarking a candidate reverts it without recording a run", async () => {
    const cwd = createFixtureRepo();

    await expect(executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(
        cwd,
        async (_prompt, callCount) => {
          if (callCount === 1) {
            return buildInitPlan({
              maxIterations: 1,
              benchmark: {
                argv: [
                  "bun",
                  "-e",
                  [
                    "import { readFileSync, writeFileSync } from 'node:fs';",
                    "const score = readFileSync('score.txt', 'utf8').trim();",
                    "if (score !== '100') writeFileSync('benchmark-ran.txt', `${score}\\n`);",
                    "console.log(`score=${score}`);",
                  ].join(" "),
                ],
                metric: {
                  name: "score",
                  direction: "lower",
                  source: "stdout-regex",
                  pattern: "score=(\\d+(?:\\.\\d+)?)",
                },
              },
            });
          }
          if (callCount === 2) {
            return buildExperimentSpec("Lower the score", "Write 90 to score.txt", "score drops from 100 to 90");
          }

          writeFileSync(join(cwd, "score.txt"), "90\n", "utf8");
          return buildApplyResult("Wrote 90 to score.txt");
        },
        [],
        {
          assertNotCancelled() {
            if (existsSync(join(cwd, "benchmark-ran.txt"))) {
              throw new RunCancelledError("Stopped.", "soft_stop");
            }
          },
        },
      ),
    )).rejects.toThrow("Stopped.");

    const paths = resolveAutoresearchPaths(cwd);
    expect(readAutoresearchState(paths)?.status).toBe("inactive");
    expect(readFileSync(join(cwd, "score.txt"), "utf8")).toBe("100\n");
    expect(existsSync(join(cwd, "benchmark-ran.txt"))).toBe(false);
    expect(readExperimentLog(paths).map((record) => record.id)).toEqual(["baseline"]);
  });

  test("keeps improved experiments, rejects regressions, and records confidence", async () => {
    const cwd = createFixtureRepo();

    await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return buildInitPlan({ maxIterations: 2 });
        }
        if (callCount === 2) {
          return buildExperimentSpec("Lower the score", "Write 90 to score.txt", "score drops from 100 to 90");
        }
        if (callCount === 3) {
          writeFileSync(join(cwd, "score.txt"), "90\n", "utf8");
          return buildApplyResult("Wrote 90 to score.txt");
        }
        if (callCount === 4) {
          return buildExperimentSpec("Increase the score", "Write 120 to score.txt", "score rises from 90 to 120");
        }

        writeFileSync(join(cwd, "score.txt"), "120\n", "utf8");
        return buildApplyResult("Wrote 120 to score.txt");
      }),
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
    writeFileSync(join(cwd, "gate.txt"), "pass\n", "utf8");
    execFileSync("git", ["add", "gate.txt"], { cwd, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add gate fixture"], { cwd, stdio: "pipe" });

    await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return buildInitPlan({
            maxIterations: 1,
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
          });
        }
        if (callCount === 2) {
          return {
            ...buildExperimentSpec(
              "Lower the score",
              "Write 80 to score.txt and fail the smoke gate",
              "score drops from 100 to 80",
            ),
            filesInScope: ["score.txt", "gate.txt"],
          } satisfies AutoresearchExperimentSpec;
        }

        writeFileSync(join(cwd, "score.txt"), "80\n", "utf8");
        writeFileSync(join(cwd, "gate.txt"), "fail\n", "utf8");
        return {
          summary: "Wrote 80 to score.txt and failed gate.txt",
          touchedFiles: ["score.txt", "gate.txt"],
        } satisfies AutoresearchApplyResult;
      }),
    );

    const records = readExperimentLog(resolveAutoresearchPaths(cwd));
    expect(records[1]?.decision.status).toBe("failed");
    expect(records[1]?.decision.reason).toContain("Check failed: smoke");
    expect(readFileSync(join(cwd, "score.txt"), "utf8")).toBe("100\n");
    expect(readFileSync(join(cwd, "gate.txt"), "utf8")).toBe("pass\n");
    expect(getCommitCount(cwd)).toBe(2);
  });

  test("clear removes repo-local state after a foreground run completes", async () => {
    const cwd = createFixtureRepo();
    await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return buildInitPlan({ maxIterations: 3 });
        }
        return buildStopSpec("nothing useful to try yet");
      }),
    );

    const paths = resolveAutoresearchPaths(cwd);
    await executeAutoresearchClearCommand("", createMockContext(cwd, async () => {
      throw new Error("clear does not use callAgent");
    }));

    expect(readAutoresearchState(paths)).toBeUndefined();
    expect(existsSync(paths.logPath)).toBe(false);
  });

  test("clear cancels matching active autoresearch dispatches before deleting state", async () => {
    const cwd = createFixtureRepo();
    const sessionId = "test-session";
    const paths = resolveAutoresearchPaths(cwd);
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const branchName = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
    const originalHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "nab-autoresearch-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;

    try {
      writeAutoresearchState(paths, {
        schemaVersion: 1,
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
        sessionId,
        goal: "reduce the score benchmark",
        goalSummary: "reduce score",
        status: "active",
        repoRoot: cwd,
        branchName,
        baseBranch: branchName,
        baseCommit,
        mergeBaseCommit: baseCommit,
        iterationCount: 0,
        maxIterations: 3,
        filesInScope: ["score.txt"],
        benchmark: buildInitPlan().benchmark,
        checks: [],
        pendingContextNotes: [],
      });

      const sessionDir = getSessionDir(sessionId);
      mkdirSync(join(sessionDir, "procedure-dispatch-jobs"), { recursive: true });
      const dispatchId = "dispatch-active-autoresearch";
      const dispatchPath = buildProcedureDispatchJobPath(sessionDir, dispatchId);
      writeFileSync(dispatchPath, `${JSON.stringify({
        dispatchId,
        sessionId,
        procedure: "autoresearch/continue",
        prompt: "",
        status: "running",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:01.000Z",
        startedAt: "2026-04-08T00:00:01.000Z",
        dispatchCorrelationId: "corr-autoresearch-active",
      }, null, 2)}\n`);

      const cleared = await executeAutoresearchClearCommand("", createMockContext(cwd, async () => {
        throw new Error("clear does not use callAgent");
      }, [], { sessionId }));

      expect(cleared.summary).toBe("autoresearch/clear: cleared state");
      expect(cleared.display).toContain("Cancelled 1 active autoresearch dispatch");
      expect(readAutoresearchState(paths)).toBeUndefined();
      expect(isProcedureDispatchCancellationRequested(sessionDir, "corr-autoresearch-active")).toBe(true);
      const updatedJob = JSON.parse(readFileSync(dispatchPath, "utf8")) as { status: string; error?: string };
      expect(updatedJob.status).toBe("cancelled");
      expect(updatedJob.error).toBe("Stopped.");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test("finalize creates review branches for kept experiment commits", async () => {
    const cwd = createFixtureRepo();
    await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return buildInitPlan({ maxIterations: 1 });
        }
        if (callCount === 2) {
          return buildExperimentSpec("Lower the score", "Write 90 to score.txt", "score drops from 100 to 90");
        }

        writeFileSync(join(cwd, "score.txt"), "90\n", "utf8");
        return {
          summary: "Wrote 90 to score.txt",
          touchedFiles: ["score.txt"],
        } satisfies AutoresearchApplyResult;
      }),
    );

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

  test("finalize replays prior kept commits onto later review branches", async () => {
    const cwd = createFixtureRepo();
    await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return buildInitPlan({ maxIterations: 2 });
        }
        if (callCount === 2) {
          return buildExperimentSpec("Lower the score", "Write 90 to score.txt", "score drops from 100 to 90");
        }
        if (callCount === 3) {
          writeFileSync(join(cwd, "score.txt"), "90\n", "utf8");
          return buildApplyResult("Wrote 90 to score.txt");
        }
        if (callCount === 4) {
          return buildExperimentSpec("Lower the score again", "Write 80 to score.txt", "score drops from 90 to 80");
        }

        writeFileSync(join(cwd, "score.txt"), "80\n", "utf8");
        return buildApplyResult("Wrote 80 to score.txt");
      }),
    );

    const branchBeforeFinalize = getCurrentBranch(cwd);
    const result = await executeAutoresearchFinalizeCommand(
      "",
      createMockContext(cwd, async () => {
        throw new Error("finalize does not use callAgent");
      }),
    );

    const branches = (result.data as { branches: Array<{ branchName: string }> }).branches;
    expect(branches).toHaveLength(2);
    expect(readGitFile(cwd, branches[0]?.branchName as string, "score.txt")).toBe("90");
    expect(readGitFile(cwd, branches[1]?.branchName as string, "score.txt")).toBe("80");
    expect(getCurrentBranch(cwd)).toBe(branchBeforeFinalize);
  });

  test("prints high-signal commentary for baseline, iteration progress, decisions, and completion", async () => {
    const cwd = createFixtureRepo();
    const printed: string[] = [];

    await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
          return buildInitPlan({ maxIterations: 2 });
        }
        if (callCount === 2) {
          return buildExperimentSpec("Lower the score", "Write 90 to score.txt", "score drops from 100 to 90");
        }
        if (callCount === 3) {
          writeFileSync(join(cwd, "score.txt"), "90\n", "utf8");
          return buildApplyResult("Wrote 90 to score.txt");
        }
        if (callCount === 4) {
          return buildExperimentSpec("Increase the score", "Write 120 to score.txt", "score rises from 90 to 120");
        }

        writeFileSync(join(cwd, "score.txt"), "120\n", "utf8");
        return buildApplyResult("Wrote 120 to score.txt");
      }, printed),
    );

    const stream = printed.join("");
    expect(stream).toContain("Baseline: score -> 100.");
    expect(stream).toContain("Iteration 1/2: selecting the next experiment.");
    expect(stream).toContain("Iteration 2/2: selecting the next experiment.");
    expect(stream).toContain("Result: 90, improvement kept.");
    expect(stream).toContain("Result: 120, reverted.");
    expect(stream).toContain("Autoresearch finished after 2 iterations. Best score: 90.");
  });

  test("reports explicit command guidance when no autoresearch session exists", async () => {
    const cwd = createFixtureRepo();
    const ctx = createMockContext(cwd, async () => {
      throw new Error("missing-state commands should not callAgent");
    });

    const overview = await executeAutoresearchCommand("status", ctx);
    const status = await executeAutoresearchStatusCommand("", ctx);
    const continuation = await executeAutoresearchContinueCommand("", ctx);
    const clear = await executeAutoresearchClearCommand("", ctx);
    const finalize = await executeAutoresearchFinalizeCommand("", ctx);

    expect(overview.display).toContain("/autoresearch/start <goal>");
    expect(status.display).toBe(
      "No autoresearch session exists in this repository yet. Run /autoresearch/start <goal> to create one.\n",
    );
    expect(continuation.display).toBe(
      "Cannot continue autoresearch: no session exists in this repository yet. Run /autoresearch/start <goal> to create one.\n",
    );
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

function buildExperimentSpec(
  idea: string,
  editInstructions: string,
  expectedMetricEffect: string,
): AutoresearchExperimentSpec {
  return {
    idea,
    rationale: `${idea} directly changes score.txt`,
    filesInScope: ["score.txt"],
    editInstructions,
    expectedMetricEffect,
    commitMessage: `autoresearch: ${idea.toLowerCase()}`,
  };
}

function buildStopSpec(stopReason: string): AutoresearchExperimentSpec {
  return {
    stop: true,
    stopReason,
    idea: "stop",
    rationale: "no further worthwhile experiment",
    filesInScope: [],
    editInstructions: "No changes.",
  };
}

function buildApplyResult(summary: string): AutoresearchApplyResult {
  return {
    summary,
    touchedFiles: ["score.txt"],
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
  printed: string[] = [],
  options: {
    sessionId?: string;
    assertNotCancelled?: (checkCount: number) => void;
  } = {},
): ProcedureApi {
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "copilot",
    command: "copilot",
    args: [],
    cwd,
  };
  let callCount = 0;
  let cancellationCheckCount = 0;
  const callAgent = (async (prompt: string) => {
    callCount += 1;
    return {
      run: {
        sessionId: options.sessionId ?? "test-session",
        runId: `agent-${callCount}`,
      },
      data: await handler(prompt, callCount),
    } as RunResult;
  }) as ProcedureApi["agent"]["run"];
  const refs: ProcedureApi["state"]["refs"] = {
    async read() {
      throw new Error("Not implemented in test");
    },
    async stat() {
      throw new Error("Not implemented in test");
    },
    async writeToFile() {
      throw new Error("Not implemented in test");
    },
  };
  const runs: ProcedureApi["state"]["runs"] = {
    async list() {
      return [];
    },
    async get() {
      throw new Error("Not implemented in test");
    },
    async getAncestors() {
      return [];
    },
    async getDescendants() {
      return [];
    },
  };
  const agent: ProcedureApi["agent"] = {
    run: callAgent,
    session() {
      return {
        run: callAgent,
      };
    },
  };

  return {
    cwd,
    sessionId: options.sessionId ?? "test-session",
    agent,
    state: {
      runs,
      refs,
    },
    ui: {
      text(text: string) {
        printed.push(text);
      },
      info(text: string) {
        printed.push(text);
      },
      warning(text: string) {
        printed.push(text);
      },
      error(text: string) {
        printed.push(text);
      },
      status() {},
      card() {},
    },
    procedures: {
      async run() {
        throw new Error("Not implemented in test");
      },
    },
    session: {
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
    },
    assertNotCancelled() {
      cancellationCheckCount += 1;
      options.assertNotCancelled?.(cancellationCheckCount);
    },
  };
}

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

function resolveGitPath(cwd: string, path: string): string {
  return join(
    resolveAutoresearchPaths(cwd).repoRoot,
    execFileSync("git", ["rev-parse", "--git-path", path], {
      cwd,
      encoding: "utf8",
    }).trim(),
  );
}
