import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRef, type DownstreamAgentConfig, type RunRecord, type RunRef } from "@nanoboss/contracts";
import { resolveSelfCommandWithRuntime } from "@nanoboss/app-support";
import {
  executeProcedure,
  findRecoveredProcedureDispatchRun,
  procedureDispatchResultFromRecoveredRun,
  ProcedureCancelledError,
  waitForRecoveredProcedureDispatchRun,
} from "@nanoboss/procedure-engine";
import type {
  Procedure,
  ProcedureApi,
  ProcedureRegistryLike,
} from "@nanoboss/procedure-sdk";
import { jsonType } from "@nanoboss/procedure-sdk";
import { SessionStore } from "@nanoboss/store";

const DEFAULT_AGENT_CONFIG: DownstreamAgentConfig = {
  command: "mock-agent",
  args: [],
};
interface TypedAgentResult {
  result: number;
}

const tempDirs: string[] = [];
let originalHome: string | undefined;
const TypedAgentResultType = jsonType<TypedAgentResult>(
  {
    type: "object",
    properties: {
      result: { type: "number" },
    },
    required: ["result"],
    additionalProperties: false,
  },
  (input): input is TypedAgentResult => {
    return (
      typeof input === "object" &&
      input !== null &&
      typeof (input as { result?: unknown }).result === "number" &&
      Object.keys(input as Record<string, unknown>).length === 1
    );
  },
);

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

test("uses the canonical self-command helper owner", () => {
  expect(resolveSelfCommandWithRuntime("mcp", [], {
    executable: "/Users/jflam/.local/bin/nanoboss",
    scriptPath: "/$bunfs/root/nanoboss.js",
  })).toEqual({
    command: "/Users/jflam/.local/bin/nanoboss",
    args: ["mcp"],
  });
});

function createFakeStore(): {
  store: Parameters<typeof executeProcedure>[0]["store"];
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
    store: store as unknown as Parameters<typeof executeProcedure>[0]["store"],
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
): Parameters<typeof executeProcedure>[0] {
  return {
    cwd: store.cwd,
    sessionId: store.sessionId,
    store,
    registry,
    procedure,
    prompt,
    emitter: createEmitter(),
    bindings: {
      getDefaultAgentConfig: () => DEFAULT_AGENT_CONFIG,
      setDefaultAgentSelection: () => DEFAULT_AGENT_CONFIG,
    },
  };
}

describe("procedure-engine runtime with procedure-sdk procedures", () => {
  test("runs top-level procedures and records child procedure runs", async () => {
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

    const result = await executeProcedure(buildRunParams(store, registry, parent, "run parent"));

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

  test("preserves display and explicit schemas from procedure-sdk child results", async () => {
    const store = createStore("nab-procedure-engine-child-result-shape");
    const childSchema = {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
      additionalProperties: false,
    };
    const child: Procedure = {
      name: "child",
      description: "Nested child procedure",
      async execute() {
        return {
          data: { answer: "child-result" },
          display: "child display",
          summary: "child summary",
          explicitDataSchema: childSchema,
        };
      },
    };
    const parent: Procedure = {
      name: "parent",
      description: "Parent procedure",
      async execute(_prompt: string, ctx: ProcedureApi) {
        const childResult = await ctx.procedures.run<{ answer: string }>("child", "nested prompt");
        return {
          data: {
            childDisplay: childResult.display,
            childSchema: childResult.explicitDataSchema,
            childShape: childResult.dataShape,
          },
          summary: "parent summary",
        };
      },
    };
    const registry = createRegistry([parent, child]);

    const result = await executeProcedure(buildRunParams(store, registry, parent, "run parent"));

    const parentRun = store.getRun(result.run);
    expect(parentRun.output.data).toEqual({
      childDisplay: "child display",
      childSchema,
      childShape: {
        answer: "child-result",
      },
    });
  });

  test("supports pause and resume for procedure-sdk procedures", async () => {
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

    const paused = await executeProcedure(buildRunParams(store, registry, pauseable, "start"));
    expect(paused.pause?.question).toBe("Continue?");
    if (!paused.pause) {
      throw new Error("expected paused procedure state");
    }

    const resumed = await executeProcedure({
      ...buildRunParams(store, registry, pauseable, "ship it"),
      resume: {
        prompt: "ship it",
        state: paused.pause.state,
      },
    });

    expect(resumed.pause).toBeUndefined();
    expect(resumed.display).toBe("resumed: ship it\n");
    expect(resumed.summary).toBe("step 1");
  });

  test("finds and rehydrates recovered dispatch runs for procedure-sdk procedures", async () => {
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
    const result = await executeProcedure({
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

  test("enforces cancellation boundaries for procedure-sdk procedures", async () => {
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

    await expect(executeProcedure({
      ...buildRunParams(store, registry, cancellable, "stop"),
      softStopSignal: controller.signal,
    })).rejects.toBeInstanceOf(ProcedureCancelledError);
  });

  test("treats late cancellation as authoritative even when a procedure returns normally", async () => {
    const store = createStore("nab-procedure-engine-late-cancel");
    let releaseWait!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const cancellable: Procedure = {
      name: "cancellable",
      description: "Returns after an ignored async wait",
      async execute() {
        await waitForRelease;
        return {
          display: "should not finish\n",
        };
      },
    };
    const registry = createRegistry([cancellable]);
    const controller = new AbortController();
    const runPromise = executeProcedure({
      ...buildRunParams(store, registry, cancellable, "stop later"),
      softStopSignal: controller.signal,
    });

    controller.abort();
    releaseWait();

    await expect(runPromise).rejects.toBeInstanceOf(ProcedureCancelledError);
  });

  test("shapes typed callAgent child results for procedure-sdk consumers", async () => {
    const store = createStore("nab-procedure-engine-typed-agent");
    const fakeAgentSession = {
      sessionId: "fake-typed-session",
      async getCurrentTokenSnapshot() {
        return undefined;
      },
      async prompt() {
        return {
          raw: "{\"result\":7}",
          durationMs: 0,
          updates: [],
        };
      },
      updateConfig() {},
      close() {},
    };
    const usesTypedAgent: Procedure = {
      name: "typed-agent",
      description: "Returns a typed downstream agent result",
      async execute(_prompt, ctx) {
        const result = await ctx.agent.run("Return {\"result\":7}.", TypedAgentResultType, {
          session: "default",
          stream: false,
        });
        return {
          data: {
            value: result.data,
            display: result.display,
            explicitDataSchema: result.explicitDataSchema,
            dataShape: result.dataShape,
          },
          summary: "typed agent complete",
        };
      },
    };
    const registry = createRegistry([usesTypedAgent]);

    const typedAgentParams = buildRunParams(store, registry, usesTypedAgent, "go");
    const result = await executeProcedure({
      ...typedAgentParams,
      bindings: {
        ...typedAgentParams.bindings,
        agentSession: fakeAgentSession,
        prepareDefaultPrompt: (promptInput) => ({ promptInput }),
      },
    });

    expect(store.getRun(result.run).output.data).toEqual({
      value: { result: 7 },
      display: "{\"result\":7}",
      explicitDataSchema: TypedAgentResultType.schema,
      dataShape: {
        result: "number",
      },
    });

    const descendants = store.getRunDescendants(result.run, { maxDepth: 1 });
    expect(descendants).toHaveLength(1);
    const childRun = descendants[0] ? store.getRun(descendants[0].run) : undefined;
    expect(childRun?.procedure).toBe("callAgent");
    expect(childRun?.output.explicitDataSchema).toEqual(TypedAgentResultType.schema);
    expect(childRun?.output.display).toBe("{\"result\":7}");
  });

  test("suppresses typed default-session JSON chunks and emits a structured output card", async () => {
    const store = createStore("nab-procedure-engine-typed-default-structured");
    const forwardedUpdates: unknown[] = [];
    const uiEvents: unknown[] = [];
    const fakeAgentSession = {
      sessionId: "fake-typed-default-structured-session",
      async getCurrentTokenSnapshot() {
        return undefined;
      },
      async prompt() {
        return {
          raw: "{\"result\":7}",
          durationMs: 0,
          updates: [
            {
              sessionUpdate: "agent_message_chunk" as const,
              content: {
                type: "text" as const,
                text: "{\"result\":7}",
              },
            },
          ],
        };
      },
      updateConfig() {},
      close() {},
    };
    const usesTypedDefaultSession: Procedure = {
      name: "typed-default-structured",
      description: "Uses the default session for structured output",
      async execute(_prompt, ctx) {
        await ctx.agent.run("Return {\"result\":7}.", TypedAgentResultType, {
          session: "default",
        });
        return {
          summary: "structured output captured",
        };
      },
    };
    const registry = createRegistry([usesTypedDefaultSession]);
    const runParams = buildRunParams(store, registry, usesTypedDefaultSession, "go");

    await executeProcedure({
      ...runParams,
      emitter: {
        emit(update) {
          forwardedUpdates.push(update);
        },
        emitUiEvent(event) {
          uiEvents.push(event);
        },
        async flush() {},
      },
      bindings: {
        ...runParams.bindings,
        agentSession: fakeAgentSession,
        prepareDefaultPrompt: (promptInput) => ({ promptInput }),
      },
    });

    expect(
      forwardedUpdates.filter((update) =>
        (update as { sessionUpdate?: unknown }).sessionUpdate === "agent_message_chunk"
      ),
    ).toHaveLength(0);
    expect(uiEvents).toContainEqual(expect.objectContaining({
      type: "procedure_panel",
      rendererId: "nb/card@1",
      payload: expect.objectContaining({
        title: "Structured output",
        markdown: expect.stringContaining("Generated structured JSON."),
      }),
    }));
    const structuredPanel = uiEvents.find((event) =>
      (event as { type?: unknown }).type === "procedure_panel"
    ) as { payload?: { markdown?: string } } | undefined;
    expect(structuredPanel?.payload?.markdown).toContain("output.data");
    expect(structuredPanel?.payload?.markdown).not.toContain("{\"result\":7}");
  });

  test("uses the injected default agent session for procedure-sdk procedures", async () => {
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

    const defaultSessionParams = buildRunParams(store, registry, usesDefaultSession, "go");
    const result = await executeProcedure({
      ...defaultSessionParams,
      bindings: {
        ...defaultSessionParams.bindings,
        agentSession: fakeAgentSession,
        prepareDefaultPrompt: (promptInput) => ({ promptInput }),
      },
    });

    expect(prompts).toEqual(["reuse the default session"]);
    expect(getRun(result.run).output.data).toEqual({
      reply: "default-agent-reply",
      sessionId: "fake-default-session",
    });
  });
});
