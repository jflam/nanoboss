import { expect, test } from "bun:test";

import { CommandContextImpl } from "../../src/context.ts";
import { RunLogger } from "../../src/logger.ts";
import { ProcedureRegistry } from "../../src/registry.ts";
import type { Procedure, TypeDescriptor } from "../../src/types.ts";
import { describeE2E } from "./helpers.ts";

interface MathResult {
  result: number;
}

const MathResultType: TypeDescriptor<MathResult> = {
  schema: {
    type: "object",
    properties: {
      result: { type: "number" },
    },
    required: ["result"],
    additionalProperties: false,
  },
  validate(input: unknown): input is MathResult {
    return (
      typeof input === "object" &&
      input !== null &&
      "result" in input &&
      typeof (input as { result: unknown }).result === "number"
    );
  },
};

describeE2E("callProcedure composition (real agent)", () => {
  test(
    "quadruple composes double",
    async () => {
      const registry = new ProcedureRegistry();

      const double: Procedure = {
        name: "double",
        description: "Double a number",
        async execute(prompt, ctx) {
          const result = await ctx.callAgent<MathResult>(
            `Double this number and return JSON with result only: ${prompt}`,
            MathResultType,
          );
          return String(result.value.result);
        },
      };

      const quadruple: Procedure = {
        name: "quadruple",
        description: "Quadruple a number",
        async execute(prompt, ctx) {
          const doubled = await ctx.callProcedure("double", prompt);
          return ctx.callProcedure("double", doubled);
        },
      };

      registry.register(double);
      registry.register(quadruple);

      const logger = new RunLogger();
      const ctx = new CommandContextImpl({
        cwd: process.cwd(),
        logger,
        registry,
        procedureName: "quadruple",
        spanId: logger.newSpan(),
        emitter: {
          emit() {},
          async flush() {},
        },
      });

      const result = await registry.get("quadruple")?.execute("5", ctx);
      expect(Number(result)).toBe(20);
    },
    60_000,
  );
});
