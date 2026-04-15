import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import executePlan from "../../.nanoboss/procedures/execute-plan.ts";
import {
  type CommandCallProcedureOptions,
  createRef,
  createRunRef,
  type KernelValue,
  type ProcedureApi,
  type Ref,
  type RunRef,
  type RunResult,
} from "../../src/core/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("/execute-plan", () => {
  test("executes one selected step, runs checks, commits, and pauses for follow-up", async () => {
    const cwd = createGitRepo();
    writeFileSync(join(cwd, "src", "app.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(join(cwd, "tests", "app.test.ts"), "export {};\n", "utf8");
    writeFileSync(
      join(cwd, "plans", "demo.md"),
      [
        "# Demo Plan",
        "",
        "1. Implement the feature",
        "2. Verify the result",
        "",
      ].join("\n"),
      "utf8",
    );
    execGit(cwd, ["add", "."]);
    execGit(cwd, ["commit", "-m", "Add plan scaffold"]);

    const commitDisplayRef = createRef(runRef("commit-proc"), "output.display");
    const agentCalls: unknown[][] = [];
    const procedureCalls: Array<{ name: string; prompt: string }> = [];
    const ctx = createProcedureApi({
      cwd,
      onAgentRun: async (...args) => {
        agentCalls.push(args);
        if (agentCalls.length === 1) {
          return {
            run: runRef("selector"),
            data: {
              status: "continue",
              rationale: "Step 1 is next.",
              completionSummary: null,
              blockerQuestion: null,
              stepId: "1.",
              stepIndex: 1,
              stepTitle: "Implement the feature",
              stepGoal: "Add the planned behavior",
              stepInstructions: ["Update src/app.ts", "Add a focused test"],
              successSignals: ["Targeted tests pass"],
              commitContext: "Implement the feature step",
            },
          };
        }

        writeFileSync(join(cwd, "src", "app.ts"), "export const value = 2;\n", "utf8");
        return {
          run: runRef("worker"),
          data: {
            status: "completed",
            summary: "Implemented the requested change.",
            filesChanged: ["src/app.ts", "tests/app.test.ts"],
            verification: ["bun test tests/app.test.ts"],
            blockers: [],
            followupSuggestions: ["continue"],
          },
          tokenUsage: {
            source: "acp_usage_update",
            sessionId: "impl-session-1",
          },
          defaultAgentSelection: {
            provider: "codex",
            model: "gpt-5.4/high",
          },
        };
      },
      onProcedureRun: async (name, prompt) => {
        procedureCalls.push({ name, prompt });
        if (name === "nanoboss/pre-commit-checks") {
          return {
            run: runRef("precommit"),
            data: {
              passed: true,
            },
          };
        }

        if (name === "nanoboss/commit") {
          return {
            run: runRef("commit-proc"),
            displayRef: commitDisplayRef,
            summary: "nanoboss/commit: Implement the feature step",
          };
        }

        throw new Error(`Unexpected procedure: ${name}`);
      },
      onReadRef: async (ref) => {
        if (sameRef(ref, commitDisplayRef)) {
          return "abc123 Implement the feature step";
        }
        throw new Error(`Unexpected ref read: ${ref.run.runId}:${ref.path}`);
      },
    });

    const result = await executePlan.execute("plans/demo.md continue from step 1", ctx);

    expect(result.pause).toBeDefined();
    expect(result.summary).toBe("execute-plan: completed 1. Implement the feature");
    expect(result.display).toContain("Step result: 1. Implement the feature.");
    expect(result.display).toContain("Commit: abc123 Implement the feature step");
    expect(procedureCalls).toEqual([
      { name: "nanoboss/pre-commit-checks", prompt: "" },
      { name: "nanoboss/commit", prompt: "Implement the feature step" },
    ]);
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0]?.[2]).toEqual({
      session: "fresh",
      stream: false,
    });
    expect(agentCalls[1]?.[2]).toEqual({
      session: "fresh",
      stream: false,
    });

    const state = result.pause?.state as {
      planPath: string;
      currentStepId: string;
      currentStepIndex: number;
      lastCompletedStep: {
        implementationSessionId?: string;
        commitRun?: RunRef;
      };
    };
    expect(state.planPath).toBe("plans/demo.md");
    expect(state.currentStepId).toBe("1.");
    expect(state.currentStepIndex).toBe(1);
    expect(state.lastCompletedStep.implementationSessionId).toBe("impl-session-1");
    expect(state.lastCompletedStep.commitRun).toEqual(runRef("commit-proc"));
  });

  test("routes follow-up questions back to the implementation session", async () => {
    const state = {
      version: 1,
      planPath: "plans/demo.md",
      extraInstructions: "",
      autoApprove: false,
      continuationNotes: [],
      currentStepId: "1.",
      currentStepIndex: 1,
      completedSteps: [
        {
          stepId: "1.",
          stepIndex: 1,
          stepTitle: "Implement the feature",
          stepGoal: "Add the planned behavior",
          status: "completed",
          implementationSummary: "Implemented the requested change.",
          filesChanged: ["src/app.ts"],
          verification: ["bun test tests/app.test.ts"],
          blockers: [],
          followupSuggestions: [],
          implementationRun: runRef("worker"),
          implementationSessionId: "impl-session-1",
          implementationAgentSelection: {
            provider: "codex",
            model: "gpt-5.4/high",
          },
          preCommitRun: runRef("precommit"),
          commitRun: runRef("commit-proc"),
          commitSummary: "abc123 Implement the feature step",
          completedAt: new Date().toISOString(),
        },
      ],
      lastCompletedStep: {
        stepId: "1.",
        stepIndex: 1,
        stepTitle: "Implement the feature",
        stepGoal: "Add the planned behavior",
        status: "completed",
        implementationSummary: "Implemented the requested change.",
        filesChanged: ["src/app.ts"],
        verification: ["bun test tests/app.test.ts"],
        blockers: [],
        followupSuggestions: [],
        implementationRun: runRef("worker"),
        implementationSessionId: "impl-session-1",
        implementationAgentSelection: {
          provider: "codex",
          model: "gpt-5.4/high",
        },
        preCommitRun: runRef("precommit"),
        commitRun: runRef("commit-proc"),
        commitSummary: "abc123 Implement the feature step",
        completedAt: new Date().toISOString(),
      },
    };

    const agentCalls: unknown[][] = [];
    const ctx = createProcedureApi({
      cwd: createGitRepo(),
      onAgentRun: async (...args) => {
        agentCalls.push(args);
        if (agentCalls.length === 1) {
          return {
            run: runRef("classifier"),
            data: {
              intent: "question",
              rationale: "The user is asking about the completed work.",
              carryForwardNote: null,
              question: "What changed in the implementation?",
            },
          };
        }

        return {
          run: runRef("followup"),
          data: "I updated src/app.ts and kept the change scoped to step 1.",
        };
      },
    });

    const result = await executePlan.resume("what changed?", state, ctx);

    expect(result.pause).toBeDefined();
    expect(result.summary).toBe("execute-plan: answered question about 1. Implement the feature");
    expect(result.display).toContain("I updated src/app.ts");
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0]?.[2]).toEqual({
      session: "fresh",
      stream: false,
    });
    expect(agentCalls[1]?.[1]).toEqual({
      stream: false,
      persistedSessionId: "impl-session-1",
      agent: {
        provider: "codex",
        model: "gpt-5.4/high",
      },
      refs: {
        implementationRun: runRef("worker"),
        preCommitRun: runRef("precommit"),
        commitRun: runRef("commit-proc"),
      },
    });
  });
});

function createProcedureApi(options: {
  cwd: string;
  onAgentRun?: (
    prompt: string,
    descriptorOrOptions?: unknown,
    options?: unknown,
  ) => Promise<Partial<RunResult>>;
  onProcedureRun?: (
    name: string,
    prompt: string,
    procedureOptions?: CommandCallProcedureOptions,
  ) => Promise<Partial<RunResult>>;
  onReadRef?: (ref: Ref) => Promise<unknown>;
}): ProcedureApi {
  const agentRun = (async (
    prompt: string,
    descriptorOrOptions?: unknown,
    maybeOptions?: unknown,
  ) => {
    const result = await options.onAgentRun?.(prompt, descriptorOrOptions, maybeOptions);
    return {
      run: runRef(`agent-${crypto.randomUUID()}`),
      ...result,
    };
  }) as ProcedureApi["agent"]["run"];

  return {
    cwd: options.cwd,
    sessionId: "session",
    agent: {
      run: agentRun,
      session() {
        throw new Error("agent.session should not be called");
      },
    },
    procedures: {
      async run<T extends KernelValue = KernelValue>(
        name: string,
        prompt: string,
        procedureOptions?: CommandCallProcedureOptions,
      ): Promise<RunResult<T>> {
        if (!options.onProcedureRun) {
          throw new Error("procedures.run should not be called");
        }
        const result = await options.onProcedureRun(name, prompt, procedureOptions);
        return {
          run: runRef(`procedure-${crypto.randomUUID()}`),
          ...result,
        } as RunResult<T>;
      },
    },
    ui: {
      text() {},
      info() {},
      warning() {},
      error() {},
      status() {},
      card() {},
    },
    state: {
      runs: {} as never,
      refs: {
        async read<T = KernelValue>(ref: Ref): Promise<T> {
          if (!options.onReadRef) {
            throw new Error("state.refs.read should not be called");
          }
          return await options.onReadRef(ref) as T;
        },
        stat: async () => {
          throw new Error("state.refs.stat should not be called");
        },
        writeToFile: async () => {
          throw new Error("state.refs.writeToFile should not be called");
        },
      },
    },
    session: {
      getDefaultAgentConfig() {
        return {
          provider: "codex",
          command: "codex-acp",
          args: [],
          cwd: options.cwd,
          model: "gpt-5.4/high",
        };
      },
      setDefaultAgentSelection(selection) {
        return {
          provider: selection.provider,
          command: "codex-acp",
          args: [],
          cwd: options.cwd,
          model: selection.model,
        };
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

function createGitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "nab-execute-plan-"));
  tempDirs.push(cwd);
  mkdirSync(join(cwd, "plans"), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "tests"), { recursive: true });
  execGit(cwd, ["init"]);
  execGit(cwd, ["config", "user.email", "test@example.com"]);
  execGit(cwd, ["config", "user.name", "Test User"]);
  execGit(cwd, ["commit", "--allow-empty", "-m", "Initial commit"]);
  execGit(cwd, ["branch", "-M", "main"]);
  writeFileSync(join(cwd, ".gitignore"), ".nanoboss/\n", "utf8");
  execGit(cwd, ["add", ".gitignore"]);
  execGit(cwd, ["commit", "-m", "Add gitignore"]);
  execGit(cwd, ["status", "--short"]);
  writeFileSync(join(cwd, "README.md"), "# Test\n", "utf8");
  execGit(cwd, ["add", "README.md"]);
  execGit(cwd, ["commit", "-m", "Add README"]);
  return cwd;
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  });
}

function runRef(runId: string): RunRef {
  return createRunRef("session", runId);
}

function sameRef(left: Ref, right: Ref): boolean {
  return left.run.sessionId === right.run.sessionId
    && left.run.runId === right.run.runId
    && left.path === right.path;
}
