import { expect, test } from "bun:test";

import { jsonType, type Procedure, type ProcedureApi, type ProcedureResult } from "@nanoboss/procedure-sdk";

interface ExampleData {
  answer: string;
}

const ExampleDataType = jsonType<ExampleData>(
  {
    type: "object",
    properties: {
      answer: { type: "string" },
    },
    required: ["answer"],
  },
  (input): input is ExampleData =>
    typeof input === "object" &&
    input !== null &&
    "answer" in input &&
    typeof input.answer === "string",
);

test("procedure-sdk supports consumer-style procedure imports", () => {
  const procedure: Procedure = {
    name: "example",
    description: "Example procedure",
    async execute(_prompt: string, ctx: ProcedureApi): Promise<ProcedureResult<ExampleData>> {
      return {
        data: { answer: ctx.cwd },
        summary: ctx.sessionId,
      };
    },
  };

  expect(ExampleDataType.validate({ answer: "ok" })).toBe(true);
  expect(ExampleDataType.validate({ answer: 1 })).toBe(false);
  expect(procedure.name).toBe("example");
});
