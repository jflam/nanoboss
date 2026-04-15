import { expect, test } from "bun:test";
import typia from "typia";

import { CommandContextImpl } from "../../src/core/context.ts";
import { RunLogger } from "../../src/core/logger.ts";
import { ProcedureRegistry } from "../../src/procedure/registry.ts";
import { SessionStore } from "@nanoboss/store";
import { jsonType, type Procedure } from "../../src/core/types.ts";
import { describeE2E } from "./helpers.ts";

interface MathResult {
  result: number;
}

const MathResultType = jsonType<MathResult>(
  typia.json.schema<MathResult>(),
  typia.createValidate<MathResult>(),
);

describeE2E("ctx.procedures.run composition (real agent)", () => {
  test(
    "quadruple composes double",
    async () => {
      const registry = new ProcedureRegistry();

      const double: Procedure = {
        name: "double",
        description: "Double a number",
        async execute(prompt, ctx) {
          const result = await ctx.agent.run(
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
          const doubled = await ctx.procedures.run<{ result: number }>("double", prompt);
          const doubledData = doubled.data;
          if (!doubledData) {
            throw new Error("Missing doubled data");
          }

          const quadrupled = await ctx.procedures.run<{ result: number }>(
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
        run: store.startRun({
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
