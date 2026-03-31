import { expect, test } from "bun:test";

import { callAgent } from "../../src/call-agent.ts";
import type { TypeDescriptor } from "../../src/types.ts";
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

const MathResultType: TypeDescriptor<MathResult> = {
  schema: {
    type: "object",
    properties: {
      expression: { type: "string" },
      result: { type: "number" },
    },
    required: ["expression", "result"],
    additionalProperties: false,
  },
  validate(input: unknown): input is MathResult {
    return (
      typeof input === "object" &&
      input !== null &&
      "expression" in input &&
      typeof (input as { expression: unknown }).expression === "string" &&
      "result" in input &&
      typeof (input as { result: unknown }).result === "number"
    );
  },
};

const WordAnalysisType: TypeDescriptor<WordAnalysis> = {
  schema: {
    type: "object",
    properties: {
      word: { type: "string" },
      length: { type: "number" },
      vowels: { type: "number" },
      reversed: { type: "string" },
    },
    required: ["word", "length", "vowels", "reversed"],
    additionalProperties: false,
  },
  validate(input: unknown): input is WordAnalysis {
    return (
      typeof input === "object" &&
      input !== null &&
      "word" in input &&
      typeof (input as { word: unknown }).word === "string" &&
      "length" in input &&
      typeof (input as { length: unknown }).length === "number" &&
      "vowels" in input &&
      typeof (input as { vowels: unknown }).vowels === "number" &&
      "reversed" in input &&
      typeof (input as { reversed: unknown }).reversed === "string"
    );
  },
};

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
      const strictType: TypeDescriptor<{ uuid: string; timestamp: number }> = {
        schema: {
          type: "object",
          properties: {
            uuid: { type: "string" },
            timestamp: { type: "number" },
          },
          required: ["uuid", "timestamp"],
          additionalProperties: false,
        },
        validate(input: unknown): input is { uuid: string; timestamp: number } {
          return (
            typeof input === "object" &&
            input !== null &&
            "uuid" in input &&
            typeof (input as { uuid: unknown }).uuid === "string" &&
            "timestamp" in input &&
            typeof (input as { timestamp: unknown }).timestamp === "number"
          );
        },
      };

      await expect(callAgent("Say hello", strictType)).rejects.toThrow();
    },
    60_000,
  );
});
