import { describe, expect, test } from "bun:test";

import { createCreateProcedure } from "../../src/procedure/create.ts";

describe("create procedure", () => {
  test("reports invalid generated procedure names without obscuring the cause", async () => {
    const procedure = createCreateProcedure({
      get: () => undefined,
      register() {},
      async loadProcedureFromPath() {
        throw new Error("loadProcedureFromPath should not be called");
      },
      async persist() {
        throw new Error("persist should not be called");
      },
      listMetadata: () => [],
    });

    await expect(procedure.execute("make something", {
      cwd: process.cwd(),
      agent: {
        async run() {
          return {
            data: {
              name: "review///...",
              source: "export default { name: \"review\", description: \"\", async execute() { return {}; } };",
            },
          };
        },
        session() {
          throw new Error("agent.session should not be called");
        },
      },
      procedures: {
        run() {
          throw new Error("procedures.run should not be called");
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
        refs: {} as never,
      },
      print() {},
      getDefaultAgentConfig() {
        throw new Error("getDefaultAgentConfig should not be called");
      },
      setDefaultAgentSelection() {
        throw new Error("setDefaultAgentSelection should not be called");
      },
      assertNotCancelled() {},
      callProcedure() {
        throw new Error("callProcedure should not be called");
      },
      session: {} as never,
      refs: {} as never,
      async callAgent() {
        throw new Error("callAgent should not be called");
      },
    } as never)).rejects.toThrow("Generated procedure name was invalid: Procedure name segment was invalid");
  });
});
