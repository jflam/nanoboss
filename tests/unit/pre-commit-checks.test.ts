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
  persistPreCommitChecksRun,
  resolvePreCommitChecks,
  type CommandExecutionResult,
  type PreCommitChecksResult,
  type PreCommitChecksFreshRunReason,
} from "../../procedures/nanoboss/test-cache-lib.ts";
import type { ProcedureApi, Ref, RunResult } from "@nanoboss/procedure-sdk";

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

  test("reuses the cached result for the same workspace, runtime, and command", async () => {
    const cwd = createGitRepo();
    let runCount = 0;
    const runner = async () => {
      runCount += 1;
      return makeCommandResult({
        exitCode: 0,
        stdout: "compact test ok\n",
        summary: "Pre-commit checks passed.",
        createdAt: "2026-04-09T00:00:00.000Z",
      });
    };

    const first = await resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });
    const second = await resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });

    expect(first.cacheHit).toBe(false);
    expect(first.runReason).toBe("cold_cache");
    expect(second.cacheHit).toBe(true);
    expect(second.runReason).toBe("cache_hit");
    expect(second.exitCode).toBe(0);
    expect(second.combinedOutput).toBe("compact test ok\n");
    expect(runCount).toBe(1);
    expect(JSON.parse(readFileSync(getPreCommitChecksCachePath(cwd), "utf8"))).toMatchObject({
      command: PRE_COMMIT_CHECKS_COMMAND,
      exitCode: 0,
    });
  });

  test("changing the workspace invalidates the cache", async () => {
    const cwd = createGitRepo();
    let runCount = 0;
    const runner = async () => {
      runCount += 1;
      return makeCommandResult({
        exitCode: 0,
        stdout: `run ${runCount}\n`,
        summary: "Pre-commit checks passed.",
        createdAt: `2026-04-09T00:00:0${runCount}.000Z`,
      });
    };

    await resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });
    writeFileSync(join(cwd, "tracked.txt"), "base\nchanged\n", "utf8");
    const second = await resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });

    expect(second.cacheHit).toBe(false);
    expect(second.runReason).toBe("workspace_changed");
    expect(second.combinedOutput).toBe("run 2\n");
    expect(runCount).toBe(2);
  });

  test("changing the runtime invalidates the cache", async () => {
    const cwd = createGitRepo();
    let runCount = 0;
    const runner = async () => {
      runCount += 1;
      return makeCommandResult({
        exitCode: 0,
        stdout: `runtime ${runCount}\n`,
        summary: "Pre-commit checks passed.",
        createdAt: `2026-04-09T00:00:0${runCount}.000Z`,
      });
    };

    await resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });
    const second = await resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-b",
      runValidationCommand: runner,
    });

    expect(second.cacheHit).toBe(false);
    expect(second.runReason).toBe("runtime_changed");
    expect(runCount).toBe(2);
  });

  test("refresh bypasses the cache and overwrites the stored record", async () => {
    const cwd = createGitRepo();
    let runCount = 0;
    const runner = async () => {
      runCount += 1;
      return makeCommandResult({
        exitCode: runCount,
        stdout: `run ${runCount}\n`,
        summary: `run ${runCount}`,
        createdAt: `2026-04-09T00:00:0${runCount}.000Z`,
      });
    };

    await resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: runner,
    });
    const refreshed = await resolvePreCommitChecks({
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
    expect(refreshed.runReason).toBe("refresh");
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

  test("streams fresh command output and reports the rerun reason before execution", async () => {
    const cwd = createGitRepo();
    const freshReasons: PreCommitChecksFreshRunReason[] = [];
    const streamed: string[] = [];

    const result = await resolvePreCommitChecks({
      cwd,
      onFreshRun(event) {
        freshReasons.push(event.reason);
      },
      onOutputChunk(chunk) {
        streamed.push(chunk);
      },
      runValidationCommand: async (_cwd, options) => {
        options?.onOutputChunk?.("phase 1\n");
        options?.onOutputChunk?.("phase 2\n");
        return makeCommandResult({
          stdout: "phase 1\nphase 2\n",
        });
      },
    });

    expect(freshReasons).toEqual(["cold_cache"]);
    expect(streamed).toEqual(["phase 1\n", "phase 2\n"]);
    expect(result.cacheHit).toBe(false);
  });

  test("reuses a cache record written by a direct pre-commit command run", async () => {
    const cwd = createGitRepo();
    let runCount = 0;

    persistPreCommitChecksRun(cwd, makeCommandResult({
      exitCode: 0,
      stdout: "external precommit ok\n",
      summary: "Pre-commit checks passed.",
      createdAt: "2026-04-10T00:00:00.000Z",
    }), {
      resolveRuntimeFingerprint: () => "runtime-a",
    });

    const result = await resolvePreCommitChecks({
      cwd,
      resolveRuntimeFingerprint: () => "runtime-a",
      runValidationCommand: async () => {
        runCount += 1;
        return makeCommandResult({
          exitCode: 0,
          stdout: "unexpected rerun\n",
          createdAt: "2026-04-10T00:00:01.000Z",
        });
      },
    });

    expect(result.cacheHit).toBe(true);
    expect(result.runReason).toBe("cache_hit");
    expect(result.combinedOutput).toBe("external precommit ok\n");
    expect(runCount).toBe(0);
  });
});

describe("nanoboss/pre-commit-checks procedure", () => {
  test("replays cached output and returns the stored failure exit code", async () => {
    const printed: string[] = [];
    const procedure = createPreCommitChecksProcedure({
      async resolveChecks() {
        return {
          command: PRE_COMMIT_CHECKS_COMMAND,
          cacheHit: true,
          runReason: "cache_hit",
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
        };
      },
    });

    const result = await procedure.execute("manual-approve", createMockContext({
      cwd: "/repo",
      emitText(text) {
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
      async resolveChecks({ refresh }) {
        seenRefresh = refresh === true;
        return {
          command: PRE_COMMIT_CHECKS_COMMAND,
          cacheHit: false,
          runReason: "refresh",
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

  test("streams fresh output in verbose mode", async () => {
    const printed: string[] = [];
    const procedure = createPreCommitChecksProcedure({
      async resolveChecks(options) {
        options.onFreshRun?.({
          reason: "workspace_changed",
          command: PRE_COMMIT_CHECKS_COMMAND,
        });
        options.onOutputChunk?.("line 1\n");
        options.onOutputChunk?.("line 2\n");
        return {
          command: PRE_COMMIT_CHECKS_COMMAND,
          cacheHit: false,
          runReason: "workspace_changed",
          exitCode: 0,
          passed: true,
          workspaceStateFingerprint: "workspace",
          runtimeFingerprint: "runtime",
          createdAt: "2026-04-09T00:00:00.000Z",
          stdout: "line 1\nline 2\n",
          stderr: "",
          combinedOutput: "line 1\nline 2\n",
          summary: "passed",
          durationMs: 5,
        };
      },
    });

    await procedure.execute("--verbose", createMockContext({
      cwd: "/repo",
      emitText(text) {
        printed.push(text);
      },
    }));

    expect(printed).toEqual([
      `Dirty repo detected; re-running checks for confidence with \`${PRE_COMMIT_CHECKS_COMMAND}\`.\n`,
      "line 1\n",
      "line 2\n",
    ]);
  });

  test("auto-runs one automated fix pass by default when checks fail", async () => {
    const calls: string[] = [];
    let refreshes: boolean[] = [];
    const procedure = createPreCommitChecksProcedure({
      async resolveChecks({ refresh }) {
        refreshes = [...refreshes, refresh === true];
        if (refresh) {
          return {
            command: PRE_COMMIT_CHECKS_COMMAND,
            cacheHit: false,
            runReason: "refresh",
            exitCode: 0,
            passed: true,
            workspaceStateFingerprint: "workspace",
            runtimeFingerprint: "runtime",
            createdAt: "2026-04-09T00:00:01.000Z",
            stdout: "all clean\n",
            stderr: "",
            combinedOutput: "all clean\n",
            summary: "passed",
            durationMs: 5,
          };
        }

        return {
          command: PRE_COMMIT_CHECKS_COMMAND,
          cacheHit: false,
          runReason: "cold_cache",
          exitCode: 2,
          passed: false,
          workspaceStateFingerprint: "workspace",
          runtimeFingerprint: "runtime",
          createdAt: "2026-04-09T00:00:00.000Z",
          stdout: "",
          stderr: "typecheck failed\n",
          combinedOutput: [
            '[[nanoboss-precommit]] {"type":"run_result","phases":[{"phase":"lint","status":"passed","exitCode":0},{"phase":"typecheck","status":"failed","exitCode":2},{"phase":"typecheck:packages","status":"not_run"},{"phase":"knip","status":"not_run"},{"phase":"test:packages","status":"not_run"},{"phase":"test","status":"not_run"}]}',
            "procedures/example.ts(12,3): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
          ].join("\n"),
          summary: "failed",
          durationMs: 5,
        };
      },
    });

    const result = await procedure.execute("", createMockContext({
      cwd: "/repo",
      async runAgent(prompt) {
        calls.push(prompt);
        return {
          run: { sessionId: "session", runId: "agent" },
          data: "Applied focused fixes.\n",
          dataRef: makeRef("agent"),
        } satisfies RunResult<string>;
      },
    }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("The user reply was: auto-approved by default");
    expect(refreshes).toEqual([false, true]);
    expect(result).toMatchObject({
      data: {
        passed: true,
        exitCode: 0,
      },
    });
    if (!result || typeof result === "string") {
      throw new Error("Expected procedure result object");
    }
    expect(result.pause).toBeUndefined();
  });

  test("manual-approve pauses with a fix offer when checks fail", async () => {
    const procedure = createPreCommitChecksProcedure({
      async resolveChecks() {
        return {
          command: PRE_COMMIT_CHECKS_COMMAND,
          cacheHit: false,
          runReason: "cold_cache",
          exitCode: 2,
          passed: false,
          workspaceStateFingerprint: "workspace",
          runtimeFingerprint: "runtime",
          createdAt: "2026-04-09T00:00:00.000Z",
          stdout: "",
          stderr: "typecheck failed\n",
          combinedOutput: [
            '[[nanoboss-precommit]] {"type":"run_result","phases":[{"phase":"lint","status":"passed","exitCode":0},{"phase":"typecheck","status":"failed","exitCode":2},{"phase":"typecheck:packages","status":"not_run"},{"phase":"knip","status":"not_run"},{"phase":"test:packages","status":"not_run"},{"phase":"test","status":"not_run"}]}',
            "procedures/example.ts(12,3): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
          ].join("\n"),
          summary: "failed",
          durationMs: 5,
        };
      },
    });

    const result = await procedure.execute("manual-approve", createMockContext({ cwd: "/repo" }));

    expect(result).toMatchObject({
      data: {
        passed: false,
        exitCode: 2,
      },
      pause: {
        suggestedReplies: ["yes, fix them", "no, leave them"],
      },
    });
    if (typeof result === "string" || !result?.pause) {
      throw new Error("Expected paused procedure result");
    }
    expect(result.display).toContain("Validation summary:");
    expect(result.display).toContain("- lint: passed");
    expect(result.display).toContain("- typecheck: failed (exit 2)");
    expect(result.display).toContain("- typecheck:packages: not run");
    expect(result.display).toContain("- knip: not run");
    expect(result.display).toContain("- test:packages: not run");
    expect(result.display).toContain("- test: not run");
    expect(result.pause.question).toContain("Do you want me to try fixing these automatically?");
  });

  test("resume can run one automated fix pass and rerun checks", async () => {
    const calls: string[] = [];
    let refreshes: boolean[] = [];
    const procedure = createPreCommitChecksProcedure({
      async resolveChecks({ refresh }) {
        refreshes = [...refreshes, refresh === true];
        if (refresh) {
          return {
            command: PRE_COMMIT_CHECKS_COMMAND,
            cacheHit: false,
            runReason: "refresh",
            exitCode: 0,
            passed: true,
            workspaceStateFingerprint: "workspace",
            runtimeFingerprint: "runtime",
            createdAt: "2026-04-09T00:00:01.000Z",
            stdout: "all clean\n",
            stderr: "",
            combinedOutput: "all clean\n",
            summary: "passed",
            durationMs: 5,
          };
        }

        return {
          command: PRE_COMMIT_CHECKS_COMMAND,
          cacheHit: false,
          runReason: "cold_cache",
          exitCode: 2,
          passed: false,
          workspaceStateFingerprint: "workspace",
          runtimeFingerprint: "runtime",
          createdAt: "2026-04-09T00:00:00.000Z",
          stdout: "",
          stderr: "typecheck failed\n",
          combinedOutput: "typecheck failed\n",
          summary: "failed",
          durationMs: 5,
        };
      },
    });

    const initial = await procedure.execute("manual-approve", createMockContext({ cwd: "/repo" }));
    if (typeof initial === "string" || !initial?.pause) {
      throw new Error("Expected paused procedure result");
    }

    const resumed = await procedure.resume?.(
      "yes, fix them",
      initial.pause.state,
      createMockContext({
        cwd: "/repo",
        async runAgent(prompt) {
          calls.push(prompt);
          return {
            run: { sessionId: "session", runId: "agent" },
            data: "Applied focused fixes.\n",
            dataRef: makeRef("agent"),
          } satisfies RunResult<string>;
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("fix the current pre-commit check failures");
    expect(calls[0]).toContain("typecheck failed");
    expect(refreshes).toEqual([false, true]);
    expect(resumed).toBeDefined();
    expect(resumed).toMatchObject({
      data: {
        passed: true,
        exitCode: 0,
      },
    });
    if (typeof resumed === "string") {
      throw new Error("Expected procedure result object");
    }
    expect(resumed?.pause).toBeUndefined();
  });

  test("resume can decline the automated fix pass", async () => {
    const procedure = createPreCommitChecksProcedure({
      async resolveChecks() {
        return {
          command: PRE_COMMIT_CHECKS_COMMAND,
          cacheHit: false,
          runReason: "cold_cache",
          exitCode: 2,
          passed: false,
          workspaceStateFingerprint: "workspace",
          runtimeFingerprint: "runtime",
          createdAt: "2026-04-09T00:00:00.000Z",
          stdout: "",
          stderr: "lint failed\n",
          combinedOutput: "lint failed\n",
          summary: "failed",
          durationMs: 5,
        };
      },
    });

    const initial = await procedure.execute("manual-approve", createMockContext({ cwd: "/repo" }));
    if (typeof initial === "string" || !initial?.pause) {
      throw new Error("Expected paused procedure result");
    }

    const resumed = await procedure.resume?.(
      "no, leave them",
      initial.pause.state,
      createMockContext({ cwd: "/repo" }),
    );

    expect(resumed).toBeDefined();
    expect(resumed).toMatchObject({
      data: {
        passed: false,
        exitCode: 2,
      },
      display: "Pre-commit checks still fail. Automatic fix was skipped.\n",
    });
    if (typeof resumed === "string") {
      throw new Error("Expected procedure result object");
    }
    expect(resumed?.pause).toBeUndefined();
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
        async runProcedure(name, prompt) {
          calls.push(`procedure:${name}:${prompt}`);
          return {
            run: { sessionId: "session", runId: "checks" },
            data: passingChecks({ cacheHit: false }),
          } satisfies RunResult<PreCommitChecksResult>;
        },
        async runAgent(prompt) {
          calls.push(`agent:${prompt}`);
          return {
            run: { sessionId: "session", runId: "agent" },
            data: "committed\n",
            dataRef: makeRef("agent"),
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
        async runProcedure() {
          return {
            run: { sessionId: "session", runId: "checks" },
            data: passingChecks({ passed: false, exitCode: 2 }),
          } satisfies RunResult<PreCommitChecksResult>;
        },
        async runAgent() {
          agentCalled = true;
          return {
            run: { sessionId: "session", runId: "agent" },
            data: "unexpected",
            dataRef: makeRef("agent"),
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
        async runProcedure(name, prompt) {
          calls.push(`procedure:${name}:${prompt}`);
          return {
            run: { sessionId: "session", runId: "checks" },
            data: passingChecks({ cacheHit: true }),
          } satisfies RunResult<PreCommitChecksResult>;
        },
        async runAgent(prompt) {
          calls.push(`agent:${prompt}`);
          return {
            run: { sessionId: "session", runId: "agent" },
            data: "committed\n",
            dataRef: makeRef("agent"),
          } satisfies RunResult<string>;
        },
      }),
    );

    expect(calls[0]).toBe("procedure:nanoboss/pre-commit-checks:--refresh");
    expect(calls[1]).toContain("User-provided commit intent: tighten message.");
  });

  test("passes manual-approve through to pre-commit checks", async () => {
    const calls: string[] = [];
    const procedure = createNanobossCommitProcedure();

    await procedure.execute(
      "manual-approve tighten message",
      createMockContext({
        cwd: "/repo",
        async runProcedure(name, prompt) {
          calls.push(`procedure:${name}:${prompt}`);
          return {
            run: { sessionId: "session", runId: "checks" },
            data: passingChecks({ cacheHit: true }),
          } satisfies RunResult<PreCommitChecksResult>;
        },
        async runAgent(prompt) {
          calls.push(`agent:${prompt}`);
          return {
            run: { sessionId: "session", runId: "agent" },
            data: "committed\n",
            dataRef: makeRef("agent"),
          } satisfies RunResult<string>;
        },
      }),
    );

    expect(calls[0]).toBe("procedure:nanoboss/pre-commit-checks:manual-approve");
    expect(calls[1]).toContain("User-provided commit intent: tighten message.");
  });

  test("tells the agent to treat a referenced plan or file as primary commit intent", async () => {
    const calls: string[] = [];
    const procedure = createNanobossCommitProcedure();

    await procedure.execute(
      "commit this work described in plans/2026-04-09-pre-commit-checks-and-commit-fingerprint-plan.md",
      createMockContext({
        cwd: "/repo",
        async runProcedure() {
          return {
            run: { sessionId: "session", runId: "checks" },
            data: passingChecks({ cacheHit: true }),
          } satisfies RunResult<PreCommitChecksResult>;
        },
        async runAgent(prompt) {
          calls.push(prompt);
          return {
            run: { sessionId: "session", runId: "agent" },
            data: "committed\n",
            dataRef: makeRef("agent"),
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
    runAgent?: (prompt: string, options?: unknown) => Promise<RunResult<string>>;
    runProcedure?: (name: string, prompt: string) => Promise<RunResult>;
    emitText?: (text: string) => void;
  },
): ProcedureApi {
  const runAgent = async (prompt: string, options?: unknown) => {
    if (!overrides.runAgent) {
      throw new Error(`Unexpected ctx.agent.run: ${prompt} ${String(options)}`);
    }
    return await overrides.runAgent(prompt, options);
  };
  const runProcedure = async (name: string, prompt: string) => {
    if (!overrides.runProcedure) {
      throw new Error(`Unexpected ctx.procedures.run: ${name} ${prompt}`);
    }
    return await overrides.runProcedure(name, prompt);
  };
  const emitText = (text: string) => {
    overrides.emitText?.(text);
  };
  const refs = {} as ProcedureApi["state"]["refs"];
  const runs = {} as ProcedureApi["state"]["runs"];

  return {
    cwd: overrides.cwd,
    sessionId: "session",
    agent: {
      run: runAgent as ProcedureApi["agent"]["run"],
      session() {
        return {
          run: runAgent as ProcedureApi["agent"]["run"],
        };
      },
    },
    state: {
      runs,
      refs,
    },
    ui: {
      text: emitText,
      info: emitText,
      warning: emitText,
      error: emitText,
      status() {},
      card() {},
    },
    procedures: {
      run: runProcedure as ProcedureApi["procedures"]["run"],
    },
    session: {
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
    },
    assertNotCancelled() {},
  };
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

function makeRef(runId: string): Ref {
  return {
    run: {
      sessionId: "session",
      runId,
    },
    path: "data",
  };
}
