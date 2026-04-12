import { describe, expect, test } from "bun:test";

import simplifyProcedure from "../../procedures/simplify.ts";
import type {
  ProcedureApi,
  DownstreamAgentConfig,
  ProcedureResult,
  RunResult,
} from "../../src/core/types.ts";

describe("simplify procedure", () => {
  test("starts paused with the first opportunity", async () => {
    const prompts: string[] = [];
    const result = await simplifyProcedure.execute(
      "",
      createMockContext([
        {
          stop: false,
          title: "Inline a one-off wrapper",
          summary: "A helper exists only to forward a single call site.",
          rationale: "Removing it would reduce indirection without changing behavior.",
          files: ["src/core/service.ts"],
          instructions: "Inline the wrapper and delete the helper.",
        },
      ], prompts),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.pause?.question).toContain("Inline a one-off wrapper");
    expect(normalized.display).toContain("Simplify iteration 1");
    expect(prompts[0]).toContain("Requested focus: simplify the current project");
  });

  test("redirecting feedback skips the current opportunity and carries guidance forward", async () => {
    const prompts: string[] = [];
    const result = await simplifyProcedure.resume(
      "look for dead code instead",
      {
        originalPrompt: "simplify the project",
        notes: [],
        iteration: 1,
        currentOpportunity: {
          stop: false,
          title: "Remove an indirection layer",
          summary: "There is an unnecessary forwarding helper.",
          rationale: "Inlining it would simplify the flow.",
          files: ["src/core/service.ts"],
          instructions: "Inline the helper.",
        },
        history: [],
      },
      createMockContext([
        {
          action: "skip",
          rationale: "The user wants a different category of simplification first.",
          guidance: "focus on dead code",
        },
        {
          stop: true,
          stopReason: "No dead-code simplification stands out after review.",
          title: "",
          summary: "",
          rationale: "",
          files: [],
          instructions: "",
        },
      ], prompts),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.pause).toBeUndefined();
    expect(normalized.display).toContain("Skipped: Remove an indirection layer.");
    expect(prompts.at(-1)).toContain("focus on dead code");
  });

  test("applying feedback records history and pauses on the next opportunity", async () => {
    const result = await simplifyProcedure.resume(
      "apply it",
      {
        originalPrompt: "simplify the project",
        notes: [],
        iteration: 1,
        currentOpportunity: {
          stop: false,
          title: "Delete an obsolete shim",
          summary: "A compatibility shim is no longer needed.",
          rationale: "Deleting it would remove branching and dead code.",
          files: ["src/http/client.ts"],
          instructions: "Delete the shim and update the direct caller.",
        },
        history: [],
      },
      createMockContext([
        {
          action: "apply",
          rationale: "The user approved the current simplification.",
        },
        {
          summary: "Deleted the obsolete shim and updated the direct caller.",
          touchedFiles: ["src/http/client.ts", "src/http/server.ts"],
        },
        {
          stop: false,
          title: "Consolidate duplicate parsing",
          summary: "Two parsing helpers duplicate each other.",
          rationale: "A shared implementation would reduce duplicate logic.",
          files: ["src/session/repository.ts", "src/core/service.ts"],
          instructions: "Consolidate the overlapping parsing helper logic.",
        },
      ]),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.display).toContain("Applied: Delete an obsolete shim.");
    expect(normalized.pause?.question).toContain("Consolidate duplicate parsing");
    const pausedState = normalized.pause?.state as {
      iteration: number;
      history: Array<{ outcome: string; title: string }>;
    };
    expect(pausedState.iteration).toBe(2);
    expect(pausedState.history).toEqual([
      {
        title: "Delete an obsolete shim",
        outcome: "applied",
      },
    ]);
  });
});

function createMockContext(agentResults: unknown[], prompts: string[] = []): ProcedureApi {
  let callCount = 0;
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "copilot",
    command: "bun",
    args: [],
    cwd: process.cwd(),
  };
  const callAgent = (async (prompt: string) => {
    prompts.push(prompt);
    callCount += 1;
    const next = agentResults.shift();
    if (next === undefined) {
      throw new Error(`Unexpected callAgent #${callCount}`);
    }
    return {
      cell: {
        sessionId: "test-session",
        cellId: `agent-${callCount}`,
      },
      data: next,
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
    async recent() {
      return [];
    },
    async latest() {
      return undefined;
    },
    async topLevelRuns() {
      return [];
    },
    async get() {
      throw new Error("Not implemented in test");
    },
    async parent() {
      return undefined;
    },
    async children() {
      return [];
    },
    async ancestors() {
      return [];
    },
    async descendants() {
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
    cwd: process.cwd(),
    sessionId: "test-session",
    agent,
    state: {
      runs,
      refs,
    },
    ui: {
      text() {},
      info() {},
      warning() {},
      error() {},
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
    assertNotCancelled() {},
  };
}

function normalizeProcedureResult(value: ProcedureResult | string | void): ProcedureResult {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    return { display: value };
  }

  return value;
}
