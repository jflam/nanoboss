import { describe, expect, test } from "bun:test";

import type { FrontendCommand, FrontendEventEnvelope } from "../../src/frontend-events.ts";
import { NanobossTuiController, type SessionResponse } from "../../src/tui/controller.ts";
import type { DownstreamAgentSelection } from "../../src/types.ts";

interface FakeStreamRecord {
  sessionId: string;
  closeCount: number;
  closed: Promise<void>;
  emit: (event: FrontendEventEnvelope) => void;
  close: () => void;
}

describe("NanobossTuiController", () => {
  test("/quit and /exit request shutdown intent", async () => {
    const exits: string[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        onExit: () => {
          exits.push("exit");
        },
      },
    );

    await controller.handleSubmit("/quit");
    await controller.handleSubmit("/exit");

    expect(exits).toEqual(["exit", "exit"]);
  });

  test("/new creates a new session and reconnects the event stream", async () => {
    const createCalls: Array<DownstreamAgentSelection | undefined> = [];
    const streams: FakeStreamRecord[] = [];
    const sessions = [createSession("session-1"), createSession("session-2")];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async (_baseUrl, _cwd, selection) => {
          createCalls.push(selection);
          const session = sessions.shift();
          if (!session) {
            throw new Error("No fake session prepared");
          }
          return session;
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("/new");

    expect(createCalls).toEqual([undefined, undefined]);
    expect(streams).toHaveLength(2);
    expect(streams[0]?.closeCount).toBe(1);
    expect(controller.getState().sessionId).toBe("session-2");
    expect(controller.getState().statusLine).toBe("[session] new session-2");

    controller.requestExit();
    await expect(runPromise).resolves.toBe("session-2");
    expect(streams[1]?.closeCount).toBe(1);
  });

  test("/model picker selection sends the generated /model command", async () => {
    const sendCalls: string[] = [];
    const history: string[] = [];
    const clears: string[] = [];
    const streams: FakeStreamRecord[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async () => createSession("session-1"),
        sendSessionPrompt: async (_baseUrl, _sessionId, prompt) => {
          sendCalls.push(prompt);
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
        promptForModelSelection: async () => ({
          provider: "copilot",
          model: "gpt-5.4/xhigh",
        }),
        onAddHistory: (text) => {
          history.push(text);
        },
        onClearInput: () => {
          clears.push("clear");
        },
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("/model");

    expect(sendCalls).toEqual(["/model copilot gpt-5.4/xhigh"]);
    expect(history).toEqual(["/model copilot gpt-5.4/xhigh"]);
    expect(clears).toEqual(["clear"]);
    expect(controller.getState().agentLabel).toBe("copilot/gpt-5.4/x-high");
    expect(controller.getState().defaultAgentSelection).toEqual({
      provider: "copilot",
      model: "gpt-5.4/xhigh",
    });

    controller.requestExit();
    await runPromise;
  });

  test("inline /model updates local banner state before forwarding the command", async () => {
    const sendCalls: string[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async () => createSession("session-1"),
        sendSessionPrompt: async (_baseUrl, _sessionId, prompt) => {
          sendCalls.push(prompt);
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream([], sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("/model copilot gpt-5.4/xhigh");

    expect(controller.getState().agentLabel).toBe("copilot/gpt-5.4/x-high");
    expect(controller.getState().defaultAgentSelection).toEqual({
      provider: "copilot",
      model: "gpt-5.4/xhigh",
    });
    expect(sendCalls).toEqual(["/model copilot gpt-5.4/xhigh"]);
    expect(controller.getState().turns[0]).toMatchObject({
      role: "user",
      markdown: "/model copilot gpt-5.4/xhigh",
      status: "complete",
    });

    controller.requestExit();
    await runPromise;
  });

  test("prompt submission disables input until completion or failure", async () => {
    const streams: FakeStreamRecord[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async () => createSession("session-1"),
        sendSessionPrompt: async () => {},
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("hello");
    expect(controller.getState().turns[0]).toMatchObject({
      role: "user",
      markdown: "hello",
      status: "complete",
    });
    expect(controller.getState().inputDisabled).toBe(true);

    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "default",
      prompt: "hello",
      startedAt: new Date(0).toISOString(),
    }));
    streams[0]?.emit(eventEnvelope("text_delta", {
      runId: "run-1",
      text: "hi",
      stream: "agent",
    }));
    streams[0]?.emit(eventEnvelope("run_completed", {
      runId: "run-1",
      procedure: "default",
      completedAt: new Date(1).toISOString(),
      cell: { sessionId: "session-1", cellId: "cell-1" },
    }));

    expect(controller.getState().inputDisabled).toBe(false);
    expect(controller.getState().turns[1]).toMatchObject({
      role: "assistant",
      markdown: "hi",
      status: "complete",
    });

    await controller.handleSubmit("broken");
    expect(controller.getState().inputDisabled).toBe(true);

    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-2",
      procedure: "default",
      prompt: "broken",
      startedAt: new Date(2).toISOString(),
    }));
    streams[0]?.emit(eventEnvelope("run_failed", {
      runId: "run-2",
      procedure: "default",
      completedAt: new Date(3).toISOString(),
      error: "boom",
    }));

    expect(controller.getState().inputDisabled).toBe(false);
    expect(controller.getState().turns.at(-1)).toMatchObject({
      role: "assistant",
      markdown: "boom",
      status: "failed",
    });

    controller.requestExit();
    await runPromise;
  });

  test("resume path restores session state and reports the resumed session id", async () => {
    const resumed = createSession("session-resume", {
      agentLabel: "copilot/gpt-5.4/x-high",
      defaultAgentSelection: {
        provider: "copilot",
        model: "gpt-5.4/xhigh",
      },
    });
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
        sessionId: "session-resume",
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async () => {
          throw new Error("create should not be called during resume");
        },
        resumeHttpSession: async () => resumed,
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream([], sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-resume");

    expect(controller.getState().agentLabel).toBe("copilot/gpt-5.4/x-high");
    expect(controller.getState().defaultAgentSelection).toEqual({
      provider: "copilot",
      model: "gpt-5.4/xhigh",
    });
    expect(controller.getState().statusLine).toBe("[session] resumed session-resume");

    controller.requestExit();
    await expect(runPromise).resolves.toBe("session-resume");
  });
});

function createSession(
  sessionId: string,
  overrides: Partial<SessionResponse> = {},
): SessionResponse {
  return {
    sessionId,
    cwd: "/repo",
    commands: [{ name: "tokens", description: "show tokens" } satisfies FrontendCommand],
    buildLabel: "nanoboss-test",
    agentLabel: "copilot/default",
    ...overrides,
  };
}

function createFakeStream(
  records: FakeStreamRecord[],
  sessionId: string,
  onEvent: (event: FrontendEventEnvelope) => void,
): FakeStreamRecord {
  let resolveClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const record: FakeStreamRecord = {
    sessionId,
    closeCount: 0,
    closed,
    emit: (event) => {
      onEvent(event);
    },
    close: () => {
      record.closeCount += 1;
      resolveClosed();
    },
  };
  records.push(record);
  return record;
}

function eventEnvelope<EventType extends FrontendEventEnvelope["type"]>(
  type: EventType,
  data: Extract<FrontendEventEnvelope, { type: EventType }>["data"],
): FrontendEventEnvelope {
  return {
    sessionId: "session-1",
    seq: 1,
    type,
    data,
  } as FrontendEventEnvelope;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for controller state");
    }

    await Bun.sleep(10);
  }
}
