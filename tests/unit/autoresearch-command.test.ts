import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  executeAutoresearchClearCommand,
  executeAutoresearchCommand,
  executeAutoresearchContinueCommand,
  executeAutoresearchFinalizeCommand,
  executeAutoresearchStartCommand,
  executeAutoresearchStatusCommand,
} from "../../src/autoresearch/runner.ts";
import { readExperimentLog } from "../../src/autoresearch/log.ts";
import { readAutoresearchState, resolveAutoresearchPaths } from "../../src/autoresearch/state.ts";
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
  test("start initializes repo-local state and runs a foreground iteration", async () => {
    const cwd = createFixtureRepo();
    const printed: string[] = [];

    const result = await executeAutoresearchStartCommand(
      "reduce the score benchmark",
      createMockContext(cwd, async (_prompt, callCount) => {
        if (callCount === 1) {
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
    expect(getCurrentBranch(cwd)).toBe(state?.branchName);
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

  test("migrates legacy autoresearch storage out of .git", () => {
    const cwd = createFixtureRepo();
    const legacyStorageDir = join(cwd, ".git", "nanoboss", "autoresearch");
    mkdirSync(legacyStorageDir, { recursive: true });
    writeFileSync(join(legacyStorageDir, "autoresearch.state.json"), "{\"goal\":\"legacy\"}\n", "utf8");
    writeFileSync(join(legacyStorageDir, "autoresearch.jsonl"), "{\"id\":\"run-0001\"}\n", "utf8");
    writeFileSync(join(legacyStorageDir, "autoresearch.md"), "# Legacy\n", "utf8");

    const paths = resolveAutoresearchPaths(cwd);

    expect(paths.storageDir).toBe(join(paths.repoRoot, ".nanoboss", "autoresearch"));
    expect(readFileSync(paths.statePath, "utf8")).toBe("{\"goal\":\"legacy\"}\n");
    expect(readFileSync(paths.logPath, "utf8")).toBe("{\"id\":\"run-0001\"}\n");
    expect(readFileSync(paths.summaryPath, "utf8")).toBe("# Legacy\n");
    expect(existsSync(legacyStorageDir)).toBe(false);
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

    expect(overview.display).toContain("/autoresearch-start <goal>");
    expect(status.display).toBe(
      "No autoresearch session exists in this repository yet. Run /autoresearch-start <goal> to create one.\n",
    );
    expect(continuation.display).toBe(
      "Cannot continue autoresearch: no session exists in this repository yet. Run /autoresearch-start <goal> to create one.\n",
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
    print(text: string) {
      printed.push(text);
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
