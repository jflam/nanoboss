import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import typia from "typia";

import { CommandContextImpl, RunLogger } from "@nanoboss/procedure-engine";
import { jsonType, type ProcedureApi } from "@nanoboss/procedure-sdk";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import { SessionStore } from "@nanoboss/store";
import { describeE2E } from "./helpers.ts";

interface MathResult {
  expression: string;
  result: number;
}

interface WordAnalysis {
  word: string;
  length: number;
  vowels: number;
  reversed: string;
}

const MathResultType = jsonType<MathResult>(
  typia.json.schema<MathResult>(),
  typia.createValidate<MathResult>(),
);

const WordAnalysisType = jsonType<WordAnalysis>(
  typia.json.schema<WordAnalysis>(),
  typia.createValidate<WordAnalysis>(),
);

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describeE2E("ProcedureApi agent runs (real agent)", () => {
  test(
    "returns untyped string results through ctx.agent.run",
    async () => {
      const ctx: ProcedureApi = createContext();
      const result = await ctx.agent.run("What is 2 + 2? Reply with just the number.");

      expect(result.data?.trim()).toBe("4");
      expect(result.dataRef).toBeDefined();
    },
    60_000,
  );

  test(
    "returns typed math results through ctx.agent.run",
    async () => {
      const ctx: ProcedureApi = createContext();
      const result = await ctx.agent.run("Compute 17 * 23", MathResultType);

      expect(result.data?.result).toBe(391);
      expect(result.data?.expression).toContain("17");
      expect(result.dataRef).toBeDefined();
    },
    60_000,
  );

  test(
    "returns typed word analysis through ctx.agent.run",
    async () => {
      const ctx: ProcedureApi = createContext();
      const result = await ctx.agent.run("Analyze the word 'hello'", WordAnalysisType);

      expect(result.data?.word).toBe("hello");
      expect(result.data?.length).toBe(5);
      expect(result.data?.vowels).toBe(2);
      expect(result.data?.reversed).toBe("olleh");
    },
    60_000,
  );

  test(
    "rejects schema mismatches through ctx.agent.run",
    async () => {
      const ctx: ProcedureApi = createContext();
      const impossibleType = {
        schema: typia.json.schema<{ uuid: string; timestamp: number }>(),
        validate: (_input: unknown): _input is { uuid: string; timestamp: number } => false,
      };

      await expect(ctx.agent.run("Say hello", impossibleType)).rejects.toThrow();
    },
    60_000,
  );
});

function createContext(): CommandContextImpl {
  const cwd = mkdtempSync(join(tmpdir(), "nab-procedure-api-"));
  tempDirs.push(cwd);

  const logger = new RunLogger();
  const store = new SessionStore({
    sessionId: crypto.randomUUID(),
    cwd,
  });

  return new CommandContextImpl({
    cwd,
    logger,
    registry: new ProcedureRegistry(),
    procedureName: "typed-e2e",
    spanId: logger.newSpan(),
    emitter: {
      emit() {},
      async flush() {},
    },
    store,
    run: store.startRun({
      procedure: "typed-e2e",
      input: "typed-e2e",
      kind: "top_level",
    }),
  });
}
