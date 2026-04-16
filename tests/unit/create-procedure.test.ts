import { describe, expect, test } from "bun:test";

import { createCreateProcedure } from "../../procedures/create.ts";
import type { ProcedureApi, ProcedureRegistryLike } from "@nanoboss/procedure-sdk";
import { normalizeProcedureResult } from "@nanoboss/store";

describe("create procedure", () => {
  test("reports invalid generated procedure names without obscuring the cause", async () => {
    const procedure = createCreateProcedure(createRegistry({
      async loadProcedureFromPath() {
        throw new Error("loadProcedureFromPath should not be called");
      },
      async persist() {
        throw new Error("persist should not be called");
      },
    }));

    await expect(procedure.execute("make something", createProcedureApi(async () => {
      return {
        data: {
          name: "review///...",
          source: "export default { name: \"review\", description: \"\", async execute() { return {}; } };",
        },
      };
    }))).rejects.toThrow("Generated procedure name was invalid: Procedure name segment was invalid");
  });

  test("teaches generated procedures the ProcedureApi surface", async () => {
    let generatedPrompt = "";
    let generatedOptions: unknown;
    const procedure = createCreateProcedure(createRegistry({
      async loadProcedureFromPath() {
        return {
          name: "review",
          description: "review",
          async execute() {
            return {};
          },
        };
      },
      async persist() {
        return "/tmp/review.ts";
      },
    }));

    await procedure.execute("make something", createProcedureApi(async (...args: unknown[]) => {
      generatedPrompt = args[0] as string;
      generatedOptions = args[2];
      return {
        data: {
          name: "review",
          source: [
            'import type { ProcedureApi } from "@nanoboss/procedure-sdk";',
            "",
            "export default {",
            "  name: \"review\",",
            "  description: \"review\",",
            "  async execute(prompt: string, ctx: ProcedureApi) {",
            "    return { summary: prompt + ctx.cwd };",
            "  },",
            "};",
          ].join("\n"),
        },
      };
    }));

    expect(generatedPrompt).toContain("ctx: ProcedureApi");
    expect(generatedPrompt).toContain("The procedure API provides:");
    expect(generatedPrompt).toContain(".nanoboss/procedures/<name>.ts");
    expect(generatedPrompt).toContain('@nanoboss/procedure-sdk');
    expect(generatedPrompt).toContain("Do not import from root `src/` paths.");
    expect(generatedPrompt).toContain("Return exactly one JSON object matching the requested schema.");
    expect(generatedPrompt).not.toContain("CommandContext");
    expect(generatedOptions).toEqual({ stream: false });
  });

  test("rewrites generated src imports, then loads and registers the new procedure", async () => {
    let persistedSource = "";
    let persistedPath = "";
    let loadedPath = "";
    let registeredName = "";
    const procedure = createCreateProcedure(createRegistry({
      async loadProcedureFromPath(path) {
        loadedPath = path;
        return {
          name: "review",
          description: "review",
          async execute() {
            return {};
          },
        };
      },
      async persist(_name, source) {
        persistedSource = source;
        persistedPath = "/repo/.nanoboss/procedures/review.ts";
        return persistedPath;
      },
      register(procedure) {
        registeredName = procedure.name;
      },
    }));

    const result = normalizeProcedureResult(await procedure.execute("make something", createProcedureApi(async () => {
      return {
        data: {
          name: "review",
          source: [
            'import type { ProcedureApi } from "@nanoboss/contracts";',
            'import { expectData } from "../src/core/run-result.ts";',
            "",
            "export default {",
            "  name: \"wrong-name\",",
            "  description: \"review\",",
            "  async execute(prompt: string, ctx: ProcedureApi) {",
            "    return { summary: prompt + String(Boolean(expectData) && ctx.cwd) };",
            "  },",
            "};",
          ].join("\n"),
        },
      };
    })));

    expect(persistedSource).toContain('import type { ProcedureApi } from "@nanoboss/procedure-sdk";');
    expect(persistedSource).toContain('import { expectData } from "@nanoboss/procedure-sdk";');
    expect(persistedSource).toContain('name: "review"');
    expect(loadedPath).toBe(persistedPath);
    expect(registeredName).toBe("review");
    expect(result.display).toContain("Created and loaded procedure /review");
  });
});

function createRegistry(
  overrides: Partial<ProcedureRegistryLike> = {},
): ProcedureRegistryLike {
  return {
    get: () => undefined,
    register() {},
    async loadProcedureFromPath() {
      throw new Error("loadProcedureFromPath should not be called");
    },
    async persist() {
      throw new Error("persist should not be called");
    },
    listMetadata: () => [],
    ...overrides,
  };
}

function createProcedureApi(
  agentRun: (
    prompt: string,
    descriptorOrOptions?: unknown,
    options?: unknown,
  ) => Promise<{ data?: unknown }>,
): ProcedureApi {
  const run = (async (
    prompt: string,
    descriptorOrOptions?: unknown,
    options?: unknown,
  ) => {
    const result = await agentRun(prompt, descriptorOrOptions, options);
    return {
      run: {
        sessionId: "session",
        runId: "agent-run",
      },
      ...result,
    };
  }) as ProcedureApi["agent"]["run"];

  return {
    cwd: process.cwd(),
    sessionId: "session",
    agent: {
      run,
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
    session: {
      getDefaultAgentConfig() {
        throw new Error("session.getDefaultAgentConfig should not be called");
      },
      setDefaultAgentSelection() {
        throw new Error("session.setDefaultAgentSelection should not be called");
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
