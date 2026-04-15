import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  callMcpTool,
  listMcpTools,
} from "@nanoboss/adapters-mcp";
import { createRef } from "../../src/core/types.ts";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import { createNanobossRuntimeService } from "../../src/runtime/service.ts";
import { SessionStore } from "@nanoboss/store";

const tempDirs: string[] = [];
const SELF_COMMAND_PATH = join(process.cwd(), "dist", "nanoboss");
let originalSelfCommand = process.env.NANOBOSS_SELF_COMMAND;
const BUILD_HOOK_TIMEOUT_MS = 30_000;

beforeAll(() => {
  const build = spawnSync("bun", ["run", "build"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (build.status !== 0) {
    throw new Error([build.stdout, build.stderr].filter(Boolean).join("\n"));
  }

  originalSelfCommand = process.env.NANOBOSS_SELF_COMMAND;
  process.env.NANOBOSS_SELF_COMMAND = SELF_COMMAND_PATH;
}, BUILD_HOOK_TIMEOUT_MS);

afterAll(() => {
  if (originalSelfCommand === undefined) {
    delete process.env.NANOBOSS_SELF_COMMAND;
  } else {
    process.env.NANOBOSS_SELF_COMMAND = originalSelfCommand;
  }
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

function expectDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

function expectString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  return value;
}

function seedSession(rootDir: string) {
  const store = new SessionStore({
    sessionId: "mcp-test-session",
    cwd: process.cwd(),
    rootDir,
  });

  const reviewCell = store.startRun({
    procedure: "second-opinion",
    input: "review the code",
    kind: "top_level",
  });
  reviewCell.meta.createdAt = "2026-04-01T10:00:00.000Z";
  const planCell = store.startRun({
    procedure: "review-plan",
    input: "collect the main issues",
    kind: "procedure",
    parentRunId: reviewCell.run.runId,
  });
  planCell.meta.createdAt = "2026-04-01T10:00:01.000Z";
  const critiqueCell = store.startRun({
    procedure: "callAgent",
    input: "critique the code",
    kind: "agent",
    parentRunId: planCell.run.runId,
  });
  critiqueCell.meta.createdAt = "2026-04-01T10:00:02.000Z";
  const summaryCell = store.startRun({
    procedure: "callAgent",
    input: "summarize the review",
    kind: "agent",
    parentRunId: reviewCell.run.runId,
  });
  summaryCell.meta.createdAt = "2026-04-01T10:00:03.000Z";

  const critiqueResult = store.completeRun(critiqueCell, {
    data: {
      verdict: "mixed",
      issues: ["missing evidence"],
    },
    display: "critique display",
    summary: "critique summary",
  });
  const planResult = store.completeRun(planCell, {
    data: {
      critique: expectDefined(critiqueResult.dataRef, "Expected critique dataRef"),
      steps: ["inspect diff", "check tests"],
    },
    display: "plan display",
    summary: "plan summary",
  });
  const summaryResult = store.completeRun(summaryCell, {
    data: {
      outline: "review outline",
    },
    display: "summary display",
    summary: "summary summary",
  });
  const reviewResult = store.completeRun(reviewCell, {
    data: {
      subject: "review the code",
      plan: expectDefined(planResult.dataRef, "Expected plan dataRef"),
      summary: expectDefined(summaryResult.dataRef, "Expected summary dataRef"),
      verdict: "mixed",
    },
    display: "review display",
    summary: "review summary",
    memory: "The main issue was missing evidence.",
    explicitDataSchema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        plan: { type: "object" },
        summary: { type: "object" },
        verdict: { enum: ["sound", "mixed", "flawed"] },
      },
    },
  });

  store.completeRun(
    (() => {
      const linterCell = store.startRun({
        procedure: "linter",
        input: "lint the repo",
        kind: "top_level",
      });
      linterCell.meta.createdAt = "2026-04-01T10:00:04.000Z";
      return linterCell;
    })(),
    {
      data: {
        status: "clean",
      },
      display: "linter display",
      summary: "linter summary",
    },
  );

  return {
    critiqueResult,
    planResult,
    reviewResult,
    summaryResult,
  };
}

describe("nanoboss MCP server", () => {
  test("accepts MCP default agent selections without a model", async () => {
    const fakeApi = {
      async procedureDispatchStart(args: unknown) {
        return args;
      },
    } as unknown as Parameters<typeof callMcpTool>[0];

    await expect(callMcpTool(fakeApi, "procedure_dispatch_start", {
      name: "review",
      prompt: "patch",
      defaultAgentSelection: {
        provider: "codex",
      },
    })).resolves.toMatchObject({
      name: "review",
      prompt: "patch",
      defaultAgentSelection: {
        provider: "codex",
      },
    });
  });

  test("rejects MCP default agent selections with invalid providers", async () => {
    const fakeApi = {
      async procedureDispatchStart(args: unknown) {
        return args;
      },
    } as unknown as Parameters<typeof callMcpTool>[0];

    await expect(callMcpTool(fakeApi, "procedure_dispatch_start", {
      name: "review",
      prompt: "patch",
      defaultAgentSelection: {
        provider: "cursor",
      },
    })).rejects.toThrow("Expected defaultAgentSelection.provider to be one of claude, gemini, codex, copilot");
  });

  test("rejects non-string procedure dispatch prompts at the MCP boundary", async () => {
    const fakeApi = {
      async procedureDispatchStart(args: unknown) {
        return args;
      },
    } as unknown as Parameters<typeof callMcpTool>[0];

    await expect(callMcpTool(fakeApi, "procedure_dispatch_start", {
      name: "review",
      prompt: 7,
    })).rejects.toThrow("Expected prompt to be a non-empty string");
  });

  test("maps structural MCP tools onto the runtime service", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-mcp-test-session-"));
    tempDirs.push(rootDir);

    const { critiqueResult, planResult, reviewResult, summaryResult } = seedSession(rootDir);

    const runtime = createNanobossRuntimeService({
      sessionId: "mcp-test-session",
      cwd: process.cwd(),
      rootDir,
    });

    const recent = await callMcpTool(runtime, "list_runs", {
      procedure: "second-opinion",
      limit: 5,
      scope: "recent",
    }) as Array<{
      summary?: string;
      memory?: string;
      kind?: string;
      dataShape?: unknown;
    }>;
    expect(recent).toHaveLength(1);
    expect(recent[0]?.summary).toBe("review summary");
    expect(recent[0]?.memory).toBe("The main issue was missing evidence.");
    expect(recent[0]?.kind).toBe("top_level");
    expect(recent[0]?.dataShape).toEqual({
      subject: "string",
      plan: "Ref",
      summary: "Ref",
      verdict: "mixed",
    });

    expect((await callMcpTool(runtime, "list_runs", {}) as Array<{ procedure: string }>).map((item) => item.procedure)).toEqual([
      "linter",
      "second-opinion",
    ]);
    expect((await callMcpTool(runtime, "get_run_ancestors", {
      runRef: critiqueResult.run,
    }) as Array<{ run: { runId: string } }>).map((item) => item.run.runId)).toEqual([
      expectDefined(planResult.run, "Expected plan run").runId,
      expectDefined(reviewResult.run, "Expected review run").runId,
    ]);
    expect((await callMcpTool(runtime, "get_run_ancestors", {
      runRef: critiqueResult.run,
      limit: 1,
    }) as Array<{ run: { runId: string } }>).map((item) => item.run.runId)).toEqual([
      expectDefined(planResult.run, "Expected plan run").runId,
    ]);
    expect((await callMcpTool(runtime, "get_run_ancestors", {
      runRef: critiqueResult.run,
      includeSelf: true,
      limit: 2,
    }) as Array<{ run: { runId: string } }>).map((item) => item.run.runId)).toEqual([
      expectDefined(critiqueResult.run, "Expected critique run").runId,
      expectDefined(planResult.run, "Expected plan run").runId,
    ]);
    expect((await callMcpTool(runtime, "get_run_descendants", {
      runRef: reviewResult.run,
    }) as Array<{ run: { runId: string } }>).map((item) => item.run.runId)).toEqual([
      expectDefined(planResult.run, "Expected plan run").runId,
      expectDefined(critiqueResult.run, "Expected critique run").runId,
      expectDefined(summaryResult.run, "Expected summary run").runId,
    ]);
    expect((await callMcpTool(runtime, "get_run_descendants", {
      runRef: reviewResult.run,
      kind: "agent",
    }) as Array<{ run: { runId: string } }>).map((item) => item.run.runId)).toEqual([
      expectDefined(critiqueResult.run, "Expected critique run").runId,
      expectDefined(summaryResult.run, "Expected summary run").runId,
    ]);
    expect((await callMcpTool(runtime, "get_run_descendants", {
      runRef: reviewResult.run,
      maxDepth: 1,
    }) as Array<{ run: { runId: string } }>).map((item) => item.run.runId)).toEqual([
      expectDefined(planResult.run, "Expected plan run").runId,
      expectDefined(summaryResult.run, "Expected summary run").runId,
    ]);

    expect((await callMcpTool(runtime, "get_run", {
      runRef: reviewResult.run,
    }) as { output: { summary?: string } }).output.summary).toBe("review summary");

    const reviewDataRef = createRef(reviewResult.run, "output.data");
    const manifest = await callMcpTool(runtime, "read_ref", {
      ref: reviewDataRef,
    });
    expect(manifest).toEqual({
      subject: "review the code",
      plan: planResult.dataRef ? createRef(planResult.run, "output.data") : undefined,
      summary: summaryResult.dataRef ? createRef(summaryResult.run, "output.data") : undefined,
      verdict: "mixed",
    });

    const planRef = expectDefined(
      (manifest as { plan?: typeof planResult.dataRef }).plan,
      "Expected plan ref in manifest",
    );
    expect(await callMcpTool(runtime, "read_ref", {
      ref: planRef,
    })).toEqual({
      critique: critiqueResult.dataRef ? createRef(critiqueResult.run, "output.data") : undefined,
      steps: ["inspect diff", "check tests"],
    });
    const summaryRef = expectDefined(
      (manifest as { summary?: typeof summaryResult.dataRef }).summary,
      "Expected summary ref in manifest",
    );
    expect(await callMcpTool(runtime, "read_ref", {
      ref: summaryRef,
    })).toEqual({
      outline: "review outline",
    });

    expect((await callMcpTool(runtime, "stat_ref", {
      ref: reviewDataRef,
    }) as { type?: string }).type).toBe("object");

    const schema = await callMcpTool(runtime, "get_run_schema", {
      runRef: reviewResult.run,
    }) as {
      dataShape?: unknown;
      explicitDataSchema?: unknown;
    };
    expect(schema.dataShape).toEqual({
      subject: "string",
      plan: "Ref",
      summary: "Ref",
      verdict: "mixed",
    });
    expect(schema.explicitDataSchema).toEqual({
      type: "object",
      properties: {
        subject: { type: "string" },
        plan: { type: "object" },
        summary: { type: "object" },
        verdict: { enum: ["sound", "mixed", "flawed"] },
      },
    });
  });

  test("requires an explicit session id", async () => {
    const runtime = createNanobossRuntimeService({
      cwd: process.cwd(),
    });

    await expect(callMcpTool(runtime, "list_runs", {})).rejects.toThrow(
      "Nanoboss MCP requires an explicit sessionId or a current session for the server working directory.",
    );
  });

  test("registers and dispatches the structural MCP tools", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-mcp-test-session-"));
    tempDirs.push(rootDir);

    const { critiqueResult, reviewResult } = seedSession(rootDir);

    const runtime = createNanobossRuntimeService({
      sessionId: "mcp-test-session",
      cwd: process.cwd(),
      rootDir,
    });

    const toolNames = listMcpTools().map((tool) => tool.name);
    expect(toolNames).toContain("list_runs");
    expect(toolNames).toContain("get_run_ancestors");
    expect(toolNames).toContain("get_run_descendants");
    expect(toolNames).toContain("get_run");
    expect(toolNames).toContain("read_ref");
    expect(toolNames).toContain("stat_ref");
    expect(toolNames).toContain("get_ref_schema");
    expect(toolNames).toContain("get_run_schema");
    expect(toolNames).not.toContain("session_last");
    expect(toolNames).not.toContain("session_recent");
    expect(toolNames).not.toContain("cell_parent");
    expect(toolNames).not.toContain("cell_children");
    expect(toolNames).not.toContain("top_level_runs");
    expect(toolNames).not.toContain("cell_ancestors");
    expect(toolNames).not.toContain("cell_descendants");
    expect(toolNames).not.toContain("cell_get");

    expect(toolNames).toContain("procedure_list");
    expect(toolNames).toContain("procedure_get");
    expect(toolNames).toContain("procedure_dispatch_start");
    expect(toolNames).toContain("procedure_dispatch_status");
    expect(toolNames).toContain("procedure_dispatch_wait");

    expect(
      await callMcpTool(runtime, "get_run_ancestors", {
        runRef: critiqueResult.run,
        limit: 1,
      }),
    ).toMatchObject([
      { procedure: "review-plan", kind: "procedure" },
    ]);

    expect(
      await callMcpTool(runtime, "get_run_descendants", {
        runRef: reviewResult.run,
        kind: "agent",
      }),
    ).toMatchObject([
      { procedure: "callAgent", kind: "agent" },
      { procedure: "callAgent", kind: "agent" },
    ]);
  });

  test("keeps hidden procedures out of discovery but allows direct named lookup", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-mcp-test-session-"));
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mcp-test-session-workspace-"));
    const procedureRoot = join(cwd, ".nanoboss", "procedures");
    const reviewPackageDir = join(procedureRoot, "review");
    mkdirSync(reviewPackageDir, { recursive: true });
    tempDirs.push(rootDir, cwd);

    const registry = new ProcedureRegistry({ procedureRoots: [procedureRoot] });
    registry.loadBuiltins();
    await Bun.write(join(reviewPackageDir, "index.ts"), [
      "export default {",
      '  name: "review",',
      '  description: "store a durable review result",',
      '  inputHint: "subject to review",',
      '  async execute(prompt) {',
      '    return {',
      '      data: {',
      '        subject: prompt,',
      '        verdict: "mixed",',
      '      },',
      '      display: `reviewed: ${prompt}\\n`,',
      '      summary: `review ${prompt}`,',
      '      memory: `Reviewed ${prompt}.`,',
      '    };',
      '  },',
      "};",
    ].join("\n"));
    await registry.loadFromDisk();

    const runtime = createNanobossRuntimeService({
      sessionId: "mcp-test-session",
      cwd,
      rootDir,
      registry,
    });

    const listed = await callMcpTool(runtime, "procedure_list", {}) as {
      procedures: Array<{
        name: string;
        description: string;
        inputHint?: string;
      }>;
    };
    expect(listed.procedures).toContainEqual({
      name: "review",
      description: "store a durable review result",
      inputHint: "subject to review",
    });
    expect(listed.procedures.some((procedure) => procedure.name === "default")).toBe(false);

    const listedWithHidden = await callMcpTool(runtime, "procedure_list", { includeHidden: true }) as {
      procedures: Array<{
        name: string;
        description: string;
        inputHint?: string;
      }>;
    };
    expect(listedWithHidden.procedures.some((procedure) => procedure.name === "default")).toBe(true);

    expect(await callMcpTool(runtime, "procedure_get", { name: "review" })).toEqual({
      name: "review",
      description: "store a durable review result",
      inputHint: "subject to review",
    });
    expect(await callMcpTool(runtime, "procedure_get", { name: "default" })).toEqual({
      name: "default",
      description: "Pass prompt through to the downstream agent",
      inputHint: undefined,
    });
  });

  test("dispatches procedures through the async MCP surface", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-mcp-test-session-"));
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mcp-test-session-workspace-"));
    const procedureRoot = join(cwd, ".nanoboss", "procedures");
    const reviewPackageDir = join(procedureRoot, "review");
    mkdirSync(reviewPackageDir, { recursive: true });
    tempDirs.push(rootDir, cwd);

    const registry = new ProcedureRegistry({ procedureRoots: [procedureRoot] });
    registry.loadBuiltins();
    await Bun.write(join(reviewPackageDir, "index.ts"), [
      "export default {",
      '  name: "review",',
      '  description: "store a durable review result",',
      '  inputHint: "subject to review",',
      '  async execute(prompt) {',
      '    return {',
      '      data: {',
      '        subject: prompt,',
      '        verdict: "mixed",',
      '      },',
      '      display: `reviewed: ${prompt}\\n`,',
      '      summary: `review ${prompt}`,',
      '      memory: `Reviewed ${prompt}.`,',
      '    };',
      '  },',
      "};",
    ].join("\n"));
    await registry.loadFromDisk();

    const runtime = createNanobossRuntimeService({
      sessionId: "mcp-test-session",
      cwd,
      rootDir,
      registry,
    });

    const dispatchCorrelationId = crypto.randomUUID();
    const started = await callMcpTool(runtime, "procedure_dispatch_start", {
      name: "review",
      prompt: "patch",
      dispatchCorrelationId,
    }) as {
      dispatchId: string;
      status: string;
    };
    const startedDispatchId = expectString(
      started.dispatchId,
      "Expected dispatchId to be a string",
    );

    expect(startedDispatchId).toMatch(/^dispatch_/);
    expect(started.status).toBe("queued");

    const reloadedRuntime = createNanobossRuntimeService({
      sessionId: "mcp-test-session",
      cwd,
      rootDir,
      registry,
    });

    const initialStatus = await callMcpTool(reloadedRuntime, "procedure_dispatch_status", {
      dispatchId: startedDispatchId,
    }) as {
      dispatchId: string;
      status: string;
      procedure: string;
    };
    expect(initialStatus.dispatchId).toBe(startedDispatchId);
    expect(initialStatus.procedure).toBe("review");
    expect(["queued", "running", "completed"]).toContain(initialStatus.status);

    let completed = await callMcpTool(reloadedRuntime, "procedure_dispatch_wait", {
      dispatchId: startedDispatchId,
      waitMs: 10,
    }) as {
      dispatchId: string;
      status: string;
      result?: {
        run: { sessionId: string; runId: string };
        summary?: string;
        display?: string;
        memory?: string;
        dataRef?: { run: { sessionId: string; runId: string }; path: string };
        dataShape?: { subject: string; verdict: string };
      };
    };

    while (completed.status !== "completed") {
      completed = await callMcpTool(reloadedRuntime, "procedure_dispatch_wait", {
        dispatchId: startedDispatchId,
        waitMs: 50,
      }) as typeof completed;
    }

    expect(completed.result).toMatchObject({
      summary: "review patch",
      display: "reviewed: patch\n",
      memory: "Reviewed patch.",
      dataShape: {
        subject: "patch",
        verdict: "mixed",
      },
    });

    const dispatched = expectDefined(completed.result, "Expected completed async dispatch result");
    expect(dispatched.dataRef).toBeDefined();
    expect(await callMcpTool(runtime, "list_runs", {
      procedure: "review",
    })).toMatchObject([
      {
        run: expectDefined(dispatched.run, "Expected dispatched run"),
        procedure: "review",
        summary: "review patch",
      },
    ]);
    expect((await callMcpTool(runtime, "get_run", {
      runRef: expectDefined(dispatched.run, "Expected dispatched run"),
    }) as { meta: { dispatchCorrelationId?: string } }).meta.dispatchCorrelationId).toBe(dispatchCorrelationId);
    expect(dispatched.dataRef ? await callMcpTool(runtime, "read_ref", {
      ref: dispatched.dataRef,
    }) : undefined).toEqual({
      subject: "patch",
      verdict: "mixed",
    });
  }, 30_000);
});
