import { expect, test } from "bun:test";
import typia from "typia";

import { callAgent } from "../../src/call-agent.ts";
import { jsonType } from "../../src/types.ts";
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

describeE2E("callAgent typed (real agent)", () => {
  test(
    "returns typed math results",
    async () => {
      const result = await callAgent("Compute 17 * 23", MathResultType);
      expect(result.data?.result).toBe(391);
      expect(result.data?.expression).toContain("17");
      expect(result.dataRef).toBeDefined();
    },
    60_000,
  );

  test(
    "returns typed word analysis",
    async () => {
      const result = await callAgent("Analyze the word 'hello'", WordAnalysisType);
      expect(result.data?.word).toBe("hello");
      expect(result.data?.length).toBe(5);
      expect(result.data?.vowels).toBe(2);
      expect(result.data?.reversed).toBe("olleh");
    },
    60_000,
  );

  test(
    "rejects responses that never match the schema",
    async () => {
      const impossibleType = {
        schema: typia.json.schema<{ uuid: string; timestamp: number }>(),
        validate: (_input: unknown): _input is { uuid: string; timestamp: number } => false,
      };

      await expect(callAgent("Say hello", impossibleType)).rejects.toThrow();
    },
    60_000,
  );
});
