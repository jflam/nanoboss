import { expect, test } from "bun:test";

import { CommandContextImpl } from "../../src/context.ts";
import { RunLogger } from "../../src/logger.ts";
import { ProcedureRegistry } from "../../src/registry.ts";
import { SessionStore } from "../../src/session-store.ts";
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
          const result = await ctx.callAgent(
            `Double this number and return JSON with result only: ${prompt}`,
            MathResultType,
          );

          const data: MathResult | undefined = result.data;
          if (!data) {
            throw new Error("Missing double result data");
          }

          return {
            data: {
              result: data.result,
            },
            display: String(data.result),
          };
        },
      };

      const quadruple: Procedure = {
        name: "quadruple",
        description: "Quadruple a number",
        async execute(prompt, ctx) {
          const doubled = await ctx.callProcedure<{ result: number }>("double", prompt);
          const doubledData = doubled.data;
          if (!doubledData) {
            throw new Error("Missing doubled data");
          }

          const quadrupled = await ctx.callProcedure<{ result: number }>(
            "double",
            String(doubledData.result),
          );
          const quadrupledData = quadrupled.data;
          if (!quadrupledData) {
            throw new Error("Missing quadrupled data");
          }

          return {
            data: {
              result: quadrupledData.result,
            },
            display: String(quadrupledData.result),
          };
        },
      };

      registry.register(double);
      registry.register(quadruple);

      const logger = new RunLogger();
      const store = new SessionStore({
        sessionId: crypto.randomUUID(),
        cwd: process.cwd(),
      });
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
        store,
        cell: store.startCell({
          procedure: "quadruple",
          input: "5",
          kind: "top_level",
        }),
      });

      const result = await registry.get("quadruple")?.execute("5", ctx);
      const display = typeof result === "string" ? result : result?.display;
      expect(Number(display)).toBe(20);
    },
    60_000,
  );
});
