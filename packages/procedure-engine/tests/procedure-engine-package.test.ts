import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRef, type DownstreamAgentConfig, type RunRecord, type RunRef } from "@nanoboss/contracts";
import {
  findRecoveredProcedureDispatchRun,
  procedureDispatchResultFromRecoveredRun,
  resumeProcedure,
  runProcedure,
  TopLevelProcedureCancelledError,
  waitForRecoveredProcedureDispatchRun,
} from "@nanoboss/procedure-engine";
import type {
  Procedure,
  ProcedureApi,
  ProcedureRegistryLike,
} from "@nanoboss/procedure-sdk";
import { SessionStore } from "@nanoboss/store";

const DEFAULT_AGENT_CONFIG: DownstreamAgentConfig = {
  command: "mock-agent",
  args: [],
};
const tempDirs: string[] = [];
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "nab-procedure-engine-home-"));
  tempDirs.push(process.env.HOME);
});

afterEach(() => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }

  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

function createRegistry(procedures: Procedure[]): ProcedureRegistryLike {
  const byName = new Map(procedures.map((procedure) => [procedure.name, procedure]));
  return {
    get: (name) => byName.get(name),
    register(procedure) {
      byName.set(procedure.name, procedure);
    },
    async loadProcedureFromPath() {
      throw new Error("Not implemented in test");
    },
    async persist() {
      throw new Error("Not implemented in test");
    },
    listMetadata: () => procedures.map(({ name, description, inputHint, executionMode }) => ({
      name,
      description,
      inputHint,
      executionMode,
    })),
  };
}

function createStore(name: string): SessionStore {
  const rootDir = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirs.push(rootDir);
  return new SessionStore({
    sessionId: crypto.randomUUID(),
    cwd: rootDir,
    rootDir,
  });
}

function createFakeStore(): {
  store: Parameters<typeof runProcedure>[0]["store"];
  getRun(run: RunRef): RunRecord;
} {
  type RunDraft = {
    run: RunRef;
    procedure: string;
    input: string;
    meta: {
      createdAt: string;
      parentRunId?: string;
      kind: "top_level" | "procedure" | "agent";
      dispatchCorrelationId?: string;
      promptImages?: unknown;
      defaultAgentSelection?: DownstreamAgentConfig["provider"] extends never ? never : unknown;
    };
    streamChunks: string[];
  };

  const records = new Map<string, RunRecord>();
  const store = {
    sessionId: crypto.randomUUID(),
    cwd: process.cwd(),
    rootDir: process.cwd(),
    persistPromptImages() {
      return undefined;
    },
    startRun(params: {
      procedure: string;
      input: string;
      kind: "top_level" | "procedure" | "agent";
      parentRunId?: string;
      dispatchCorrelationId?: string;
      promptImages?: unknown;
    }): RunDraft {
      return {
        run: {
          sessionId: this.sessionId,
          runId: crypto.randomUUID(),
        },
        procedure: params.procedure,
        input: params.input,
        meta: {
          createdAt: new Date().toISOString(),
          parentRunId: params.parentRunId,
          kind: params.kind,
          dispatchCorrelationId: params.dispatchCorrelationId,
          promptImages: params.promptImages,
        },
        streamChunks: [],
      };
    },
    appendStream(draft: RunDraft, text: string) {
      draft.streamChunks.push(text);
    },
    completeRun(
      draft: RunDraft,
      result: {
        data?: unknown;
        display?: string;
        summary?: string;
        memory?: string;
        pause?: unknown;
        explicitDataSchema?: object;
      },
      options: {
        stream?: string;
        raw?: string;
        meta?: { defaultAgentSelection?: unknown };
      } = {},
    ) {
      const record: RunRecord = {
        run: draft.run,
        kind: draft.meta.kind,
        procedure: draft.procedure,
        input: draft.input,
        output: {
          ...(result.data !== undefined ? { data: result.data as never } : {}),
          ...(result.display !== undefined ? { display: result.display } : {}),
          ...((draft.streamChunks.join("") || options.stream) ? { stream: draft.streamChunks.join("") || options.stream } : {}),
          ...(result.summary !== undefined ? { summary: result.summary } : {}),
          ...(result.memory !== undefined ? { memory: result.memory } : {}),
          ...(result.pause !== undefined ? { pause: result.pause as never } : {}),
          ...(result.explicitDataSchema !== undefined ? { explicitDataSchema: result.explicitDataSchema } : {}),
        },
        meta: {
          createdAt: draft.meta.createdAt,
          parentRunId: draft.meta.parentRunId,
          dispatchCorrelationId: draft.meta.dispatchCorrelationId,
          defaultAgentSelection: options.meta?.defaultAgentSelection as RunRecord["meta"]["defaultAgentSelection"],
          promptImages: undefined,
        },
      };
      records.set(record.run.runId, record);
      return {
        run: draft.run,
        data: result.data,
        dataRef: result.data !== undefined ? createRef(draft.run, "output.data") : undefined,
        displayRef: result.display !== undefined ? createRef(draft.run, "output.display") : undefined,
        streamRef: record.output.stream !== undefined ? createRef(draft.run, "output.stream") : undefined,
        pause: result.pause,
        pauseRef: result.pause !== undefined ? createRef(draft.run, "output.pause") : undefined,
        summary: result.summary,
        rawRef: options.raw !== undefined ? createRef(draft.run, "output.display") : undefined,
      };
    },
    getRun(run: RunRef): RunRecord {
      const record = records.get(run.runId);
      if (!record) {
        throw new Error(`Unknown fake run: ${run.runId}`);
      }
      return record;
    },
    discardPendingPromptImages() {},
  };

  return {
    store: store as unknown as Parameters<typeof runProcedure>[0]["store"],
    getRun: (run) => store.getRun(run),
  };
}

function createEmitter() {
  return {
    emit(_update: unknown) {},
    emitUiEvent(_event: unknown) {},
    async flush() {},
  };
}

function buildRunParams(
  store: SessionStore,
  registry: ProcedureRegistryLike,
  procedure: Procedure,
  prompt: string,
): Parameters<typeof runProcedure>[0] {
  return {
    cwd: store.cwd,
    sessionId: store.sessionId,
    store,
    registry,
    procedure,
    prompt,
    emitter: createEmitter(),
    getDefaultAgentConfig: () => DEFAULT_AGENT_CONFIG,
    setDefaultAgentSelection: () => DEFAULT_AGENT_CONFIG,
  };
}

describe("procedure-engine package", () => {
  test("runs top-level procedures and records child procedure runs via the package boundary", async () => {
    const store = createStore("nab-procedure-engine-child");
    const child: Procedure = {
      name: "child",
      description: "Nested child procedure",
      async execute() {
        return {
          data: { value: "child-result" },
          summary: "child summary",
        };
      },
    };
    const parent: Procedure = {
      name: "parent",
      description: "Parent procedure",
      async execute(_prompt: string, ctx: ProcedureApi) {
        const childResult = await ctx.procedures.run<{ value: string }>("child", "nested prompt");
        return {
          data: {
            childRunId: childResult.run.runId,
            childValue: childResult.data?.value,
          },
          summary: `parent in ${ctx.sessionId}`,
        };
      },
    };
    const registry = createRegistry([parent, child]);

    const result = await runProcedure(buildRunParams(store, registry, parent, "run parent"));

    expect(result.summary).toBe(`parent in ${store.sessionId}`);
    const descendants = store.getRunDescendants(result.run, { maxDepth: 1 });
    expect(descendants).toHaveLength(1);
    const childDescendant = descendants[0];
    expect(childDescendant?.procedure).toBe("child");
    if (!childDescendant) {
      throw new Error("expected child descendant");
    }
    const childRun = store.getRun(childDescendant.run);
    expect(childRun.output.data).toEqual({ value: "child-result" });
  });

  test("supports pause and resume through the package boundary", async () => {
    const store = createStore("nab-procedure-engine-resume");
    const pauseable: Procedure = {
      name: "pauseable",
      description: "Pauseable procedure",
      async execute() {
        return {
          display: "paused\n",
          pause: {
            question: "Continue?",
            state: { step: 1 },
          },
        };
      },
      async resume(prompt, state) {
        return {
          display: `resumed: ${prompt}\n`,
          summary: `step ${(state as { step: number }).step}`,
        };
      },
    };
    const registry = createRegistry([pauseable]);

    const paused = await runProcedure(buildRunParams(store, registry, pauseable, "start"));
    expect(paused.pause?.question).toBe("Continue?");
    if (!paused.pause) {
      throw new Error("expected paused procedure state");
    }

    const resumed = await resumeProcedure({
      ...buildRunParams(store, registry, pauseable, "ship it"),
      state: paused.pause.state,
    });

    expect(resumed.pause).toBeUndefined();
    expect(resumed.display).toBe("resumed: ship it\n");
    expect(resumed.summary).toBe("step 1");
  });

  test("finds and rehydrates recovered dispatch runs through the package boundary", async () => {
    const store = createStore("nab-procedure-engine-recovery");
    const recoverable: Procedure = {
      name: "recoverable",
      description: "Recoverable procedure",
      async execute() {
        return {
          display: "done\n",
          summary: "recovered summary",
        };
      },
    };
    const registry = createRegistry([recoverable]);
    const result = await runProcedure({
      ...buildRunParams(store, registry, recoverable, "recover me"),
      dispatchCorrelationId: "corr-recovery",
    });

    const recovered = findRecoveredProcedureDispatchRun(store, {
      procedureName: recoverable.name,
      dispatchCorrelationId: "corr-recovery",
    });
    expect(recovered?.run).toEqual(result.run);

    const waited = await waitForRecoveredProcedureDispatchRun(store, {
      procedureName: recoverable.name,
      dispatchCorrelationId: "corr-recovery",
    });
    expect(waited?.run).toEqual(result.run);
    if (!waited) {
      throw new Error("expected recovered dispatch run");
    }
    expect(procedureDispatchResultFromRecoveredRun(waited).summary).toBe("recovered summary");
  });

  test("enforces cancellation boundaries through the package boundary", async () => {
    const store = createStore("nab-procedure-engine-cancel");
    const cancellable: Procedure = {
      name: "cancellable",
      description: "Cancellable procedure",
      async execute(_prompt, ctx) {
        ctx.assertNotCancelled();
        return {
          display: "should not finish\n",
        };
      },
    };
    const registry = createRegistry([cancellable]);
    const controller = new AbortController();
    controller.abort();

    await expect(runProcedure({
      ...buildRunParams(store, registry, cancellable, "stop"),
      softStopSignal: controller.signal,
    })).rejects.toBeInstanceOf(TopLevelProcedureCancelledError);
  });

  test("uses a fake default agent session through the package boundary", async () => {
    const { store, getRun } = createFakeStore();
    const prompts: string[] = [];
    const fakeAgentSession = {
      sessionId: "fake-default-session",
      async getCurrentTokenSnapshot() {
        return {
          source: "acp_prompt_response" as const,
          sessionId: "fake-default-session",
          totalTokens: 5,
        };
      },
      async prompt(prompt: string | { parts: Array<{ type: "text"; text: string }> }) {
        prompts.push(typeof prompt === "string" ? prompt : prompt.parts.map((part) => part.text).join(""));
        return {
          raw: "default-agent-reply",
          durationMs: 0,
          updates: [],
        };
      },
      updateConfig() {},
      close() {},
    };
    const usesDefaultSession: Procedure = {
      name: "default-agent",
      description: "Uses the provided default agent session",
      async execute(_prompt, ctx) {
        const result = await ctx.agent.run("reuse the default session", {
          session: "default",
          stream: false,
        });
        return {
          data: {
            reply: result.data,
            sessionId: (await ctx.session.getDefaultAgentTokenSnapshot())?.sessionId,
          },
        };
      },
    };
    const registry = createRegistry([usesDefaultSession]);

    const result = await runProcedure({
      ...buildRunParams(store, registry, usesDefaultSession, "go"),
      agentSession: fakeAgentSession,
      prepareDefaultPrompt: (promptInput) => ({ promptInput }),
    });

    expect(prompts).toEqual(["reuse the default session"]);
    expect(getRun(result.run).output.data).toEqual({
      reply: "default-agent-reply",
      sessionId: "fake-default-session",
    });
  });
});
