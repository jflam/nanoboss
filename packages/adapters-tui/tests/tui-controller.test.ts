import { describe, expect, test } from "bun:test";

import type { DownstreamAgentSelection, PromptInput } from "@nanoboss/contracts";
import type { FrontendCommand, FrontendEventEnvelope } from "@nanoboss/adapters-http";
import { NanobossTuiController, type SessionResponse } from "@nanoboss/adapters-tui";

interface FakeStreamRecord {
  sessionId: string;
  closeCount: number;
  closed: Promise<void>;
  emit: (event: FrontendEventEnvelope) => void;
  close: () => void;
}

function toPromptText(prompt: string | PromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.parts.map((part) => part.type === "text" ? part.text : part.token).join("");
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

  test("/quit still exits while a run is active and normal submissions are disabled", async () => {
    const exits: string[] = [];
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
          sendCalls.push(toPromptText(prompt));
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream([], sessionId, onEvent),
        onExit: () => {
          exits.push("exit");
        },
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("hello");
    expect(controller.getState().inputDisabled).toBe(true);

    await controller.handleSubmit("/quit");

    expect(sendCalls).toEqual(["hello"]);
    expect(exits).toEqual(["exit"]);

    await expect(runPromise).resolves.toBe("session-1");
  });

  test("busy enter queues a steering prompt, latches stop, and submits it after the run stops", async () => {
    const sendCalls: string[] = [];
    const cancelCalls: Array<{ sessionId: string; runId: string }> = [];
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
          sendCalls.push(toPromptText(prompt));
        },
        cancelSessionRun: async (_baseUrl, sessionId, runId) => {
          cancelCalls.push({ sessionId, runId });
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("hello");
    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "default",
      prompt: "hello",
      startedAt: new Date(0).toISOString(),
    }));

    await controller.handleSubmit("steer now");

    expect(sendCalls).toEqual(["hello"]);
    expect(cancelCalls).toEqual([{ sessionId: "session-1", runId: "run-1" }]);
    expect(controller.getState().pendingPrompts).toEqual([
      {
        id: "pending-1",
        text: "steer now",
        kind: "steering",
        promptInput: {
          parts: [
            { type: "text", text: "steer now" },
          ],
        },
      },
    ]);

    streams[0]?.emit(eventEnvelope("run_cancelled", {
      runId: "run-1",
      procedure: "default",
      completedAt: new Date(1).toISOString(),
      message: "Stopped.",
    }));

    await waitFor(() => sendCalls.length === 2);

    expect(sendCalls).toEqual(["hello", "steer now"]);
    expect(controller.getState().pendingPrompts).toEqual([]);
    expect(controller.getState().turns.at(-1)).toMatchObject({
      role: "user",
      markdown: "steer now",
      status: "complete",
    });

    controller.requestExit();
    await runPromise;
  });

  test("tab-queued prompts wait for completion and steering prompts run before queued prompts", async () => {
    const sendCalls: string[] = [];
    const cancelCalls: Array<{ sessionId: string; runId: string }> = [];
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
          sendCalls.push(toPromptText(prompt));
        },
        cancelSessionRun: async (_baseUrl, sessionId, runId) => {
          cancelCalls.push({ sessionId, runId });
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("hello");
    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "default",
      prompt: "hello",
      startedAt: new Date(0).toISOString(),
    }));

    await controller.queuePrompt("queued later");
    await controller.handleSubmit("steer first");

    expect(controller.getState().pendingPrompts.map((prompt) => ({
      text: prompt.text,
      kind: prompt.kind,
    }))).toEqual([
      { text: "queued later", kind: "queued" },
      { text: "steer first", kind: "steering" },
    ]);
    expect(cancelCalls).toEqual([{ sessionId: "session-1", runId: "run-1" }]);

    streams[0]?.emit(eventEnvelope("run_cancelled", {
      runId: "run-1",
      procedure: "default",
      completedAt: new Date(1).toISOString(),
      message: "Stopped.",
    }));

    await waitFor(() => sendCalls.length === 2);
    await Bun.sleep(10);
    expect(sendCalls).toEqual(["hello", "steer first"]);

    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-2",
      procedure: "default",
      prompt: "steer first",
      startedAt: new Date(2).toISOString(),
    }));
    streams[0]?.emit(eventEnvelope("run_completed", {
      runId: "run-2",
      procedure: "default",
      completedAt: new Date(3).toISOString(),
      run: { sessionId: "session-1", runId: "cell-2" },
    }));

    await waitFor(() => sendCalls.length === 3);
    expect(sendCalls).toEqual(["hello", "steer first", "queued later"]);
    expect(controller.getState().pendingPrompts).toEqual([]);

    controller.requestExit();
    await runPromise;
  });

  test("clears remaining pending prompts when a flushed prompt fails to send", async () => {
    const sendCalls: string[] = [];
    const cancelCalls: Array<{ sessionId: string; runId: string }> = [];
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
          sendCalls.push(toPromptText(prompt));
          if (toPromptText(prompt) === "steer first") {
            throw new Error("network down");
          }
        },
        cancelSessionRun: async (_baseUrl, sessionId, runId) => {
          cancelCalls.push({ sessionId, runId });
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("hello");
    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "default",
      prompt: "hello",
      startedAt: new Date(0).toISOString(),
    }));

    await controller.queuePrompt("queued later");
    await controller.handleSubmit("steer first");

    expect(cancelCalls).toEqual([{ sessionId: "session-1", runId: "run-1" }]);

    streams[0]?.emit(eventEnvelope("run_cancelled", {
      runId: "run-1",
      procedure: "default",
      completedAt: new Date(1).toISOString(),
      message: "Stopped.",
    }));

    await waitFor(() => sendCalls.length === 2);
    await waitFor(() => controller.getState().pendingPrompts.length === 0);

    expect(sendCalls).toEqual(["hello", "steer first"]);
    expect(controller.getState().pendingPrompts).toEqual([]);
    expect(controller.getState().statusLine).toBe("[run] cleared 1 pending prompt after send failed");
    expect(controller.getState().turns.at(-1)).toMatchObject({
      role: "system",
      markdown: "network down",
      status: "failed",
    });

    controller.requestExit();
    await runPromise;
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
        createHttpSession: async (_baseUrl, _cwd, _autoApprove, selection) => {
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

  test("/dark and /light change the local tool card theme without forwarding prompts", async () => {
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
          sendCalls.push(toPromptText(prompt));
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream([], sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("/light");

    expect(controller.getState().toolCardThemeMode).toBe("light");
    expect(controller.getState().statusLine).toBe("[theme] tool cards light");
    expect(controller.getState().turns).toEqual([]);
    expect(sendCalls).toEqual([]);

    await controller.handleSubmit("hello");
    expect(controller.getState().inputDisabled).toBe(true);
    expect(sendCalls).toEqual(["hello"]);

    await controller.handleSubmit("/dark");

    expect(controller.getState().toolCardThemeMode).toBe("dark");
    expect(controller.getState().statusLine).toBe("[theme] tool cards dark");
    expect(sendCalls).toEqual(["hello"]);

    controller.requestExit();
    await runPromise;
  });

  test("/model picker selection can persist the chosen default before sending the generated command", async () => {
    const sendCalls: string[] = [];
    const history: string[] = [];
    const clears: string[] = [];
    const persisted: DownstreamAgentSelection[] = [];
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
          sendCalls.push(toPromptText(prompt));
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
        promptForModelSelection: async () => ({
          provider: "copilot",
          model: "gpt-5.4/xhigh",
        }),
        confirmPersistDefaultAgentSelection: async () => true,
        persistDefaultAgentSelection: async (selection) => {
          persisted.push(selection);
        },
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

    expect(persisted).toEqual([{ provider: "copilot", model: "gpt-5.4/xhigh" }]);
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

  test("inline /model updates local banner state, defaults persistence prompt to no, and forwards the command", async () => {
    const sendCalls: string[] = [];
    const persisted: DownstreamAgentSelection[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async () => createSession("session-1"),
        sendSessionPrompt: async (_baseUrl, _sessionId, prompt) => {
          sendCalls.push(toPromptText(prompt));
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream([], sessionId, onEvent),
        confirmPersistDefaultAgentSelection: async () => false,
        persistDefaultAgentSelection: async (selection) => {
          persisted.push(selection);
        },
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
    expect(persisted).toEqual([]);
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
      run: { sessionId: "session-1", runId: "cell-1" },
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

  test("memory sync events stay out of retained ui state", async () => {
    const streams: FakeStreamRecord[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async () => createSession("session-1"),
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("hello");
    const beforeSyncEvents = controller.getState();

    streams[0]?.emit(eventEnvelope("memory_cards", {
      runId: "run-1",
      cards: [{
        run: { sessionId: "session-1", runId: "cell-1" },
        procedure: "default",
        input: "hello",
        summary: "stored summary",
        createdAt: "2026-04-11T00:00:00.000Z",
      }],
    }));
    streams[0]?.emit(eventEnvelope("memory_card_stored", {
      runId: "run-1",
      card: {
        run: { sessionId: "session-1", runId: "cell-1" },
        procedure: "default",
        input: "hello",
        memory: "stored memory",
        createdAt: "2026-04-11T00:00:00.000Z",
      },
    }));

    expect(controller.getState()).toEqual(beforeSyncEvents);

    controller.requestExit();
    await runPromise;
  });

  test("paused runs re-enable input for open-ended replies", async () => {
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

    await controller.handleSubmit("/simplify");
    expect(controller.getState().inputDisabled).toBe(true);

    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "simplify",
      prompt: "",
      startedAt: new Date(0).toISOString(),
    }));
    streams[0]?.emit(eventEnvelope("run_paused", {
      runId: "run-1",
      procedure: "simplify",
      pausedAt: new Date(1).toISOString(),
      run: { sessionId: "session-1", runId: "cell-1" },
      question: "What would you like instead?",
      display: "Try deleting dead code first.\n\nWhat would you like instead?",
    }));

    expect(controller.getState().inputDisabled).toBe(false);
    expect(controller.getState().statusLine).toBe("[continuation] /simplify active - waiting for your reply");
    expect(controller.getState().pendingContinuation).toEqual({
      procedure: "simplify",
      question: "What would you like instead?",
      inputHint: undefined,
      suggestedReplies: undefined,
    });
    expect(controller.getState().turns.at(-1)).toMatchObject({
      role: "assistant",
      markdown: "Try deleting dead code first.\n\nWhat would you like instead?",
      status: "complete",
    });

    controller.requestExit();
    await runPromise;
  });

  test("does not auto-submit simplify2 pauses when auto-approve is enabled", async () => {
    const sendCalls: string[] = [];
    const streams: FakeStreamRecord[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
        simplify2AutoApprove: true,
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async () => createSession("session-1", { autoApprove: true }),
        sendSessionPrompt: async (_baseUrl, _sessionId, prompt) => {
          sendCalls.push(toPromptText(prompt));
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("/simplify2");
    expect(sendCalls).toEqual(["/simplify2"]);

    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "simplify2",
      prompt: "",
      startedAt: new Date(0).toISOString(),
    }));
    streams[0]?.emit(eventEnvelope("run_paused", {
      runId: "run-1",
      procedure: "simplify2",
      pausedAt: new Date(1).toISOString(),
      run: { sessionId: "session-1", runId: "cell-1" },
      question: "Approve this simplify2 slice?",
      display: "paused",
      ui: {
        kind: "simplify2_checkpoint",
        title: "Simplify2 checkpoint",
        actions: [
          { id: "approve", label: "Continue", reply: "approve it" },
          { id: "other", label: "Something Else" },
        ],
      },
    }));

    await Bun.sleep(10);

    expect(sendCalls).toEqual(["/simplify2"]);
    expect(controller.getState().simplify2AutoApprove).toBe(true);
    expect(controller.getState().inputDisabled).toBe(false);

    controller.requestExit();
    await runPromise;
  });

  test("does not auto-approve an already-paused simplify2 continuation restored on resume", async () => {
    const sendCalls: string[] = [];
    const streams: FakeStreamRecord[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
        simplify2AutoApprove: true,
        sessionId: "session-1",
      },
      {
        ensureMatchingHttpServer: async () => {},
        resumeHttpSession: async () => createSession("session-1", { autoApprove: true }),
        sendSessionPrompt: async (_baseUrl, _sessionId, prompt) => {
          sendCalls.push(toPromptText(prompt));
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    streams[0]?.emit(eventEnvelope("continuation_updated", {
      continuation: {
        procedure: "simplify2",
        question: "Approve this simplify2 slice?",
        ui: {
          kind: "simplify2_checkpoint",
          title: "Simplify2 checkpoint",
          actions: [
            { id: "approve", label: "Continue", reply: "approve it" },
            { id: "other", label: "Something Else" },
          ],
        },
      },
    }));

    await Bun.sleep(10);

    expect(sendCalls).toEqual([]);
    expect(controller.getState().simplify2AutoApprove).toBe(true);
    expect(controller.getState().pendingContinuation).toMatchObject({
      procedure: "simplify2",
      question: "Approve this simplify2 slice?",
    });
    expect(controller.getState().inputDisabled).toBe(false);

    controller.requestExit();
    await runPromise;
  });

  test("does not auto-approve simplify2 focus picker continuations", async () => {
    const sendCalls: string[] = [];
    const streams: FakeStreamRecord[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
        simplify2AutoApprove: true,
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async () => createSession("session-1", { autoApprove: true }),
        sendSessionPrompt: async (_baseUrl, _sessionId, prompt) => {
          sendCalls.push(toPromptText(prompt));
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    streams[0]?.emit(eventEnvelope("run_paused", {
      runId: "run-1",
      procedure: "simplify2",
      pausedAt: new Date(1).toISOString(),
      run: { sessionId: "session-1", runId: "cell-1" },
      question: "Choose a focus",
      display: "paused",
      ui: {
        kind: "simplify2_focus_picker",
        title: "Simplify2 focuses",
        entries: [
          {
            id: "focus-1",
            title: "Session metadata",
            status: "active",
            updatedAt: new Date(0).toISOString(),
          },
        ],
        actions: [
          { id: "continue", label: "Continue" },
          { id: "archive", label: "Archive" },
          { id: "new", label: "New Focus" },
          { id: "cancel", label: "Cancel" },
        ],
      },
    }));

    await Bun.sleep(10);

    expect(sendCalls).toEqual([]);
    expect(controller.getState().simplify2AutoApprove).toBe(true);

    controller.requestExit();
    await runPromise;
  });

  test("toggling auto-approve updates the session flag", async () => {
    const autoApproveCalls: boolean[] = [];
    const streams: FakeStreamRecord[] = [];
    const controller = new NanobossTuiController(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        ensureMatchingHttpServer: async () => {},
        createHttpSession: async () => createSession("session-1"),
        setSessionAutoApprove: async (_baseUrl, _sessionId, enabled) => {
          autoApproveCalls.push(enabled);
          return createSession("session-1", { autoApprove: enabled });
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    controller.toggleSimplify2AutoApprove();
    await waitFor(() => autoApproveCalls.length === 1);

    expect(autoApproveCalls).toEqual([true]);
    expect(controller.getState().simplify2AutoApprove).toBe(true);
    expect(controller.getState().statusLine).toBe("[session] auto-approve on");

    controller.requestExit();
    await runPromise;
  });

  test("escape-triggered cancel latches a soft stop and debounces repeated requests", async () => {
    const cancelCalls: Array<{ sessionId: string; runId: string }> = [];
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
        cancelSessionRun: async (_baseUrl, sessionId, runId) => {
          cancelCalls.push({ sessionId, runId });
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("hello");
    expect(controller.getState().inputDisabled).toBe(true);
    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "default",
      prompt: "hello",
      startedAt: new Date(0).toISOString(),
    }));

    await controller.cancelActiveRun();
    await controller.cancelActiveRun();

    expect(cancelCalls).toEqual([{ sessionId: "session-1", runId: "run-1" }]);
    expect(controller.getState().statusLine).toBe("[run] ESC received - stopping at next tool boundary...");

    controller.requestExit();
    await expect(runPromise).resolves.toBe("session-1");
  });

  test("escape before run_started waits for the run id and clears the latch on cancel failure", async () => {
    const cancelCalls: Array<{ sessionId: string; runId: string }> = [];
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
        cancelSessionRun: async (_baseUrl, sessionId, runId) => {
          cancelCalls.push({ sessionId, runId });
          throw new Error("network down");
        },
        startSessionEventStream: ({ sessionId, onEvent }) => createFakeStream(streams, sessionId, onEvent),
      },
    );

    const runPromise = controller.run();
    await waitFor(() => controller.getState().sessionId === "session-1");

    await controller.handleSubmit("hello");
    await controller.cancelActiveRun();

    expect(cancelCalls).toEqual([]);
    expect(controller.getState().pendingStopRequest).toBe(true);
    expect(controller.getState().statusLine).toBe("[run] ESC received - stopping at next tool boundary...");

    streams[0]?.emit(eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "default",
      prompt: "hello",
      startedAt: new Date(0).toISOString(),
    }));

    await waitFor(() => cancelCalls.length === 1);

    expect(cancelCalls).toEqual([{ sessionId: "session-1", runId: "run-1" }]);
    expect(controller.getState().pendingStopRequest).toBe(false);
    expect(controller.getState().stopRequestedRunId).toBeUndefined();
    expect(controller.getState().statusLine).toBe("[run] cancel failed: network down");

    controller.requestExit();
    await expect(runPromise).resolves.toBe("session-1");
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

    expect(controller.getState().cwd).toBe("/repo");
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
    autoApprove: false,
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
