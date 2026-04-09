import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNanobossCommitProcedure } from "../../procedures/nanoboss/commit.ts";
import { createPreCommitChecksProcedure } from "../../procedures/nanoboss/pre-commit-checks.ts";
import {
  PRE_COMMIT_CHECKS_COMMAND,
  computeRuntimeFingerprint,
  computeWorkspaceStateFingerprint,
  getPreCommitChecksCachePath,
  resolvePreCommitChecks,
  type CommandExecutionResult,
  type PreCommitChecksResult,
} from "../../procedures/nanoboss/test-cache-lib.ts";
import type { CommandContext, RunResult, ValueRef } from "../../src/core/types.ts";

describe("pre-commit test cache helper", () => {
  test("returns the same fingerprint for the same workspace state", () => {
    const cwd = createGitRepo();

    expect(computeWorkspaceStateFingerprint(cwd)).toBe(computeWorkspaceStateFingerprint(cwd));
  });

  test("staged changes change the workspace fingerprint", () => {
    const cwd = createGitRepo();
    const before = computeWorkspaceStateFingerprint(cwd);

    writeFileSync(join(cwd, "tracked.txt"), "base\nstaged change\n", "utf8");
    runGit(cwd, ["add", "tracked.txt"]);

    expect(computeWorkspaceStateFingerprint(cwd)).not.toBe(before);
  });

  test("unstaged changes change the workspace fingerprint", () => {
    const cwd = createGitRepo();
    const before = computeWorkspaceStateFingerprint(cwd);

    writeFileSync(join(cwd, "tracked.txt"), "base\nunstaged change\n", "utf8");

    expect(computeWorkspaceStateFingerprint(cwd)).not.toBe(before);
  });

  test("untracked relevant files change the workspace fingerprint", () => {
    const cwd = createGitRepo();
    const before = computeWorkspaceStateFingerprint(cwd);

    writeFileSync(join(cwd, "new-file.txt"), "hello\n", "utf8");

    expect(computeWorkspaceStateFingerprint(cwd)).not.toBe(before);
  });

  test("excluded directories do not affect the workspace fingerprint", () => {
    const cwd = createGitRepo();
    const before = computeWorkspaceStateFingerprint(cwd);

    mkdirSync(join(cwd, ".nanoboss"), { recursive: true });
    writeFileSync(join(cwd, ".nanoboss", "pre-commit-checks.json"), "{\"cached\":true}\n", "utf8");
    mkdirSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "dist", "bundle.js"), "console.log('ignored');\n", "utf8");

    expect(computeWorkspaceStateFingerprint(cwd)).toBe(before);
  });

  test("reuses the cached result for the same workspace, runtime, and command", () => {
    const cwd = createGitRepo();
    let runCount = 0;
    const runner = () => {
      runCount += 1;
      return makeCommandResult({
        exitCode: 0,
        stdout: "compact test ok\n",
        summary: "Pre-commit checks passed.",
        createdAt: "2026-04-09T00:00:00.000Z",
      });
    };

    const first = resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });
    const second = resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.exitCode).toBe(0);
    expect(second.combinedOutput).toBe("compact test ok\n");
    expect(runCount).toBe(1);
    expect(JSON.parse(readFileSync(getPreCommitChecksCachePath(cwd), "utf8"))).toMatchObject({
      command: PRE_COMMIT_CHECKS_COMMAND,
      exitCode: 0,
    });
  });

  test("changing the workspace invalidates the cache", () => {
    const cwd = createGitRepo();
    let runCount = 0;
    const runner = () => {
      runCount += 1;
      return makeCommandResult({
        exitCode: 0,
        stdout: `run ${runCount}\n`,
        summary: "Pre-commit checks passed.",
        createdAt: `2026-04-09T00:00:0${runCount}.000Z`,
      });
    };

    resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });
    writeFileSync(join(cwd, "tracked.txt"), "base\nchanged\n", "utf8");
    const second = resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });

    expect(second.cacheHit).toBe(false);
    expect(second.combinedOutput).toBe("run 2\n");
    expect(runCount).toBe(2);
  });

  test("changing the runtime invalidates the cache", () => {
    const cwd = createGitRepo();
    let runCount = 0;
    const runner = () => {
      runCount += 1;
      return makeCommandResult({
        exitCode: 0,
        stdout: `runtime ${runCount}\n`,
        summary: "Pre-commit checks passed.",
        createdAt: `2026-04-09T00:00:0${runCount}.000Z`,
      });
    };

    resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });
    const second = resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-b",
      runValidationCommand: runner,
    });

    expect(second.cacheHit).toBe(false);
    expect(runCount).toBe(2);
  });

  test("refresh bypasses the cache and overwrites the stored record", () => {
    const cwd = createGitRepo();
    let runCount = 0;
    const runner = () => {
      runCount += 1;
      return makeCommandResult({
        exitCode: runCount,
        stdout: `run ${runCount}\n`,
        summary: `run ${runCount}`,
        createdAt: `2026-04-09T00:00:0${runCount}.000Z`,
      });
    };

    resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });
    const refreshed = resolvePreCommitChecks({
      cwd,
      refresh: true,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });
    const cached = JSON.parse(readFileSync(getPreCommitChecksCachePath(cwd), "utf8")) as {
      exitCode: number;
      stdout: string;
      entries?: unknown;
    };

    expect(refreshed.cacheHit).toBe(false);
    expect(refreshed.exitCode).toBe(2);
    expect(runCount).toBe(2);
    expect(cached.exitCode).toBe(2);
    expect(cached.stdout).toBe("run 2\n");
    expect(cached.entries).toBeUndefined();
  });

  test("runtime fingerprint includes bun version, platform, and arch", () => {
    expect(computeRuntimeFingerprint({
      bunVersion: "1.2.3",
      platform: "darwin",
      arch: "arm64",
    })).not.toBe(computeRuntimeFingerprint({
      bunVersion: "1.2.4",
      platform: "darwin",
      arch: "arm64",
    }));
  });
});

describe("nanoboss/pre-commit-checks procedure", () => {
  test("replays cached output and returns the stored failure exit code", async () => {
    const printed: string[] = [];
    const procedure = createPreCommitChecksProcedure({
      resolveChecks: () => ({
        command: PRE_COMMIT_CHECKS_COMMAND,
        cacheHit: true,
        exitCode: 7,
        passed: false,
        workspaceStateFingerprint: "workspace",
        runtimeFingerprint: "runtime",
        createdAt: "2026-04-09T00:00:00.000Z",
        stdout: "cached stdout\n",
        stderr: "",
        combinedOutput: "cached stdout\n",
        summary: "failed",
        durationMs: 5,
      }),
    });

    const result = await procedure.execute("", createMockContext({
      cwd: "/repo",
      print(text) {
        printed.push(text);
      },
    }));

    expect(printed.join("")).toContain("cache hit");
    expect(printed.join("")).toContain("cached stdout\n");
    expect(result).toMatchObject({
      data: {
        cacheHit: true,
        exitCode: 7,
        passed: false,
      },
    });
  });

  test("passes the refresh flag to the shared helper", async () => {
    let seenRefresh = false;
    const procedure = createPreCommitChecksProcedure({
      resolveChecks: ({ refresh }) => {
        seenRefresh = refresh === true;
        return {
          command: PRE_COMMIT_CHECKS_COMMAND,
          cacheHit: false,
          exitCode: 0,
          passed: true,
          workspaceStateFingerprint: "workspace",
          runtimeFingerprint: "runtime",
          createdAt: "2026-04-09T00:00:00.000Z",
          stdout: "",
          stderr: "",
          combinedOutput: "",
          summary: "passed",
          durationMs: 5,
        };
      },
    });

    await procedure.execute("--refresh", createMockContext({ cwd: "/repo" }));

    expect(seenRefresh).toBe(true);
  });
});

describe("nanoboss/commit procedure", () => {
  test("calls pre-commit checks before invoking the commit agent", async () => {
    const calls: string[] = [];
    const procedure = createNanobossCommitProcedure();

    const result = await procedure.execute(
      "message context",
      createMockContext({
        cwd: "/repo",
        async callProcedure(name, prompt) {
          calls.push(`procedure:${name}:${prompt}`);
          return {
            cell: { sessionId: "session", cellId: "checks" },
            data: passingChecks({ cacheHit: false }),
          } satisfies RunResult<PreCommitChecksResult>;
        },
        async callAgent(prompt) {
          calls.push(`agent:${prompt}`);
          return {
            cell: { sessionId: "session", cellId: "agent" },
            data: "committed\n",
            dataRef: makeValueRef("agent"),
          } satisfies RunResult<string>;
        },
      }),
    );

    expect(calls[0]).toBe("procedure:nanoboss/pre-commit-checks:");
    expect(calls[1]).toContain("Pre-commit checks have already passed");
    expect(calls[1]).toContain("User-provided commit intent: message context.");
    expect(result).toMatchObject({
      data: {
        checks: {
          passed: true,
        },
      },
      display: "committed\n",
    });
  });

  test("blocks commit creation when pre-commit checks fail", async () => {
    let agentCalled = false;
    const procedure = createNanobossCommitProcedure();

    const result = await procedure.execute(
      "",
      createMockContext({
        cwd: "/repo",
        async callProcedure() {
          return {
            cell: { sessionId: "session", cellId: "checks" },
            data: passingChecks({ passed: false, exitCode: 2 }),
          } satisfies RunResult<PreCommitChecksResult>;
        },
        async callAgent() {
          agentCalled = true;
          return {
            cell: { sessionId: "session", cellId: "agent" },
            data: "unexpected",
            dataRef: makeValueRef("agent"),
          } satisfies RunResult<string>;
        },
      }),
    );

    expect(agentCalled).toBe(false);
    expect(result).toMatchObject({
      data: {
        checks: {
          passed: false,
          exitCode: 2,
        },
      },
      display: "Pre-commit checks failed. Commit was not created.\n",
    });
  });

  test("passes refresh through to pre-commit checks and proceeds on cached success", async () => {
    const calls: string[] = [];
    const procedure = createNanobossCommitProcedure();

    await procedure.execute(
      "--refresh tighten message",
      createMockContext({
        cwd: "/repo",
        async callProcedure(name, prompt) {
          calls.push(`procedure:${name}:${prompt}`);
          return {
            cell: { sessionId: "session", cellId: "checks" },
            data: passingChecks({ cacheHit: true }),
          } satisfies RunResult<PreCommitChecksResult>;
        },
        async callAgent(prompt) {
          calls.push(`agent:${prompt}`);
          return {
            cell: { sessionId: "session", cellId: "agent" },
            data: "committed\n",
            dataRef: makeValueRef("agent"),
          } satisfies RunResult<string>;
        },
      }),
    );

    expect(calls[0]).toBe("procedure:nanoboss/pre-commit-checks:--refresh");
    expect(calls[1]).toContain("User-provided commit intent: tighten message.");
  });

  test("tells the agent to treat a referenced plan or file as primary commit intent", async () => {
    const calls: string[] = [];
    const procedure = createNanobossCommitProcedure();

    await procedure.execute(
      "commit this work described in plans/2026-04-09-pre-commit-checks-and-commit-fingerprint-plan.md",
      createMockContext({
        cwd: "/repo",
        async callProcedure() {
          return {
            cell: { sessionId: "session", cellId: "checks" },
            data: passingChecks({ cacheHit: true }),
          } satisfies RunResult<PreCommitChecksResult>;
        },
        async callAgent(prompt) {
          calls.push(prompt);
          return {
            cell: { sessionId: "session", cellId: "agent" },
            data: "committed\n",
            dataRef: makeValueRef("agent"),
          } satisfies RunResult<string>;
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(
      "User-provided commit intent: commit this work described in plans/2026-04-09-pre-commit-checks-and-commit-fingerprint-plan.md.",
    );
    expect(calls[0]).toContain("If it references a repo file or plan, read that file first");
  });
});

function createGitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "nanoboss-pre-commit-"));
  runGit(cwd, ["init"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  writeFileSync(join(cwd, "tracked.txt"), "base\n", "utf8");
  runGit(cwd, ["add", "tracked.txt"]);
  runGit(cwd, ["commit", "-m", "Initial commit"]);
  return cwd;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
  });
}

function makeCommandResult(
  overrides: Partial<CommandExecutionResult>,
): CommandExecutionResult {
  const stdout = overrides.stdout ?? "";
  const stderr = overrides.stderr ?? "";
  return {
    exitCode: 0,
    stdout,
    stderr,
    combinedOutput: overrides.combinedOutput ?? `${stdout}${stderr}`,
    summary: "Pre-commit checks passed.",
    createdAt: "2026-04-09T00:00:00.000Z",
    durationMs: 5,
    ...overrides,
  };
}

function createMockContext(
  overrides: {
    cwd: string;
    callAgent?: (prompt: string, options?: unknown) => Promise<RunResult<string>>;
    callProcedure?: (name: string, prompt: string) => Promise<RunResult>;
    print?: (text: string) => void;
  },
): CommandContext {
  return {
    cwd: overrides.cwd,
    sessionId: "session",
    refs: {} as CommandContext["refs"],
    session: {} as CommandContext["session"],
    getDefaultAgentConfig() {
      throw new Error("not used");
    },
    setDefaultAgentSelection() {
      throw new Error("not used");
    },
    async getDefaultAgentTokenSnapshot() {
      return undefined;
    },
    async getDefaultAgentTokenUsage() {
      return undefined;
    },
    assertNotCancelled() {},
    async callAgent(prompt: string, options?: unknown) {
      if (!overrides.callAgent) {
        throw new Error(`Unexpected callAgent: ${prompt} ${String(options)}`);
      }
      return await overrides.callAgent(prompt, options);
    },
    async callProcedure(name: string, prompt: string) {
      if (!overrides.callProcedure) {
        throw new Error(`Unexpected callProcedure: ${name} ${prompt}`);
      }
      return await overrides.callProcedure(name, prompt);
    },
    print(text: string) {
      overrides.print?.(text);
    },
  } as CommandContext;
}

function passingChecks(
  overrides: Partial<PreCommitChecksResult> = {},
): PreCommitChecksResult {
  return {
    command: PRE_COMMIT_CHECKS_COMMAND,
    cacheHit: false,
    exitCode: 0,
    passed: true,
    workspaceStateFingerprint: "workspace",
    runtimeFingerprint: "runtime",
    createdAt: "2026-04-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeValueRef(cellId: string): ValueRef {
  return {
    cell: {
      sessionId: "session",
      cellId,
    },
    path: "data",
  };
}
