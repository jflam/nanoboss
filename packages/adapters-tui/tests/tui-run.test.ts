import { describe, expect, test } from "bun:test";

import { TuiExtensionRegistry } from "@nanoboss/tui-extension-catalog";
import { runTuiCli } from "@nanoboss/adapters-tui";

describe("runTuiCli", () => {
  test("stops the owned private server when app construction fails", async () => {
    const events: string[] = [];

    await expect(runTuiCli({
      cwd: "/repo-one",
      connectionMode: "private",
      showToolCalls: true,
    }, {
      startPrivateHttpServer: async () => ({
        baseUrl: "http://127.0.0.1:9999",
        async stop() {
          events.push("stopped");
        },
      }),
      createApp: () => {
        events.push("create-app");
        throw new Error("boom");
      },
    })).rejects.toThrow("boom");

    expect(events).toEqual([
      "create-app",
      "stopped",
    ]);
  });

  test("restores terminal control-character handling when app construction fails", async () => {
    const events: string[] = [];

    await expect(runTuiCli({
      cwd: "/repo-one",
      connectionMode: "private",
      showToolCalls: true,
    }, {
      suspendReservedControlCharacters: async () => {
        events.push("suspended");
        return async () => {
          events.push("restored");
        };
      },
      startPrivateHttpServer: async () => ({
        baseUrl: "http://127.0.0.1:9999",
        async stop() {
          events.push("stopped");
        },
      }),
      createApp: () => {
        events.push("create-app");
        throw new Error("boom");
      },
    })).rejects.toThrow("boom");

    expect(events).toEqual([
      "suspended",
      "create-app",
      "restored",
      "stopped",
    ]);
  });

  test("handles double SIGINT with a clean shutdown before printing the session id", async () => {
    const events: string[] = [];
    const signalHandlers: Partial<Record<"SIGINT" | "SIGTERM", () => void>> = {};
    let resolveRun: ((sessionId: string | undefined) => void) | undefined;
    let now = 1_000;
    let lastSigintAt = Number.NEGATIVE_INFINITY;

    await runTuiCli({
      cwd: "/repo-one",
      connectionMode: "private",
      showToolCalls: true,
    }, {
      suspendReservedControlCharacters: async () => {
        events.push("suspended");
        return async () => {
          events.push("restored");
        };
      },
      startPrivateHttpServer: async () => ({
        baseUrl: "http://127.0.0.1:9999",
        async stop() {
          events.push("stopped");
        },
      }),
      addSignalListener(signal, listener) {
        events.push(`listen:${signal}`);
        signalHandlers[signal] = listener;
        return () => {
          events.push(`unlisten:${signal}`);
          signalHandlers[signal] = undefined;
        };
      },
      createApp: () => ({
        requestSigintExit() {
          events.push("sigint");
          if (now - lastSigintAt < 500) {
            events.push("request-exit");
            resolveRun?.("session-123");
            return true;
          }
          lastSigintAt = now;
          return false;
        },
        requestExit() {
          events.push("request-exit");
          resolveRun?.("session-123");
        },
        async run() {
          events.push("run");
          queueMicrotask(() => {
            signalHandlers.SIGINT?.();
            now += 250;
            signalHandlers.SIGINT?.();
          });
          return await new Promise<string | undefined>((resolve) => {
            resolveRun = resolve;
          });
        },
      }),
      now: () => now,
      writeStderr(text) {
        events.push(`stderr:${text.trim()}`);
      },
      setExitCode(code) {
        events.push(`exit-code:${code}`);
      },
    });

    expect(events).toEqual([
      "suspended",
      "listen:SIGINT",
      "listen:SIGTERM",
      "run",
      "sigint",
      "sigint",
      "request-exit",
      "unlisten:SIGTERM",
      "unlisten:SIGINT",
      "restored",
      "stopped",
      "stderr:nanoboss session id: session-123",
      "exit-code:130",
    ]);
  });

  test("buffers extension boot statuses until the app can display them", async () => {
    const events: string[] = [];

    await runTuiCli({
      cwd: "/repo-one",
      connectionMode: "external",
      serverUrl: "http://127.0.0.1:9999",
      showToolCalls: true,
    }, {
      bootExtensions: (_cwd, { log }) => {
        events.push("boot");
        log("warning", "first warning");
        return {
          registry: new TuiExtensionRegistry({
            cwd: "/repo-one",
            extensionRoots: [],
          }),
          failedCount: 1,
        };
      },
      createApp: (params) => {
        events.push(params.listExtensionEntries ? "list-ready" : "list-missing");
        return {
          showStatus(text) {
            events.push(`status:${text}`);
          },
          async run() {
            events.push("run");
            return undefined;
          },
        };
      },
    });

    expect(events).toEqual([
      "boot",
      "list-ready",
      "status:[extension:warning] first warning",
      "status:[extensions] run /extensions for details",
      "run",
    ]);
  });
});
