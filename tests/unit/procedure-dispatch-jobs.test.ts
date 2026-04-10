import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, describe, test } from "bun:test";

import {
  ProcedureDispatchJobManager,
  buildProcedureDispatchJobPath,
  clearProcedureDispatchCancellation,
  isProcedureDispatchCancellationRequested,
} from "../../src/procedure/dispatch-jobs.ts";
import type { ProcedureRegistryLike } from "../../src/core/types.ts";
const MOCK_AGENT_PATH = join(process.cwd(), "tests/fixtures/mock-agent.ts");

function createManager(
  rootDir: string,
  getRegistry: () => Promise<ProcedureRegistryLike> = async () => ({
    get: () => undefined,
    register() {},
    async loadProcedureFromPath() {
      throw new Error("Not implemented in test");
    },
    async persist() {
      throw new Error("Not implemented in test");
    },
    toAvailableCommands: () => [],
  }),
): ProcedureDispatchJobManager {
  return new ProcedureDispatchJobManager({
    cwd: rootDir,
    sessionId: "session-1",
    rootDir,
    getRegistry,
  });
}

async function withMockAgentEnv(run: () => Promise<void>): Promise<void> {
  const originalCmd = process.env.NANOBOSS_AGENT_CMD;
  const originalArgs = process.env.NANOBOSS_AGENT_ARGS;
  const originalModel = process.env.NANOBOSS_AGENT_MODEL;
  const originalCooperativeCancel = process.env.MOCK_AGENT_COOPERATIVE_CANCEL;

  process.env.NANOBOSS_AGENT_CMD = "bun";
  process.env.NANOBOSS_AGENT_ARGS = JSON.stringify(["run", MOCK_AGENT_PATH]);
  delete process.env.NANOBOSS_AGENT_MODEL;
  process.env.MOCK_AGENT_COOPERATIVE_CANCEL = "1";

  try {
    await run();
  } finally {
    if (originalCmd === undefined) {
      delete process.env.NANOBOSS_AGENT_CMD;
    } else {
      process.env.NANOBOSS_AGENT_CMD = originalCmd;
    }
    if (originalArgs === undefined) {
      delete process.env.NANOBOSS_AGENT_ARGS;
    } else {
      process.env.NANOBOSS_AGENT_ARGS = originalArgs;
    }
    if (originalModel === undefined) {
      delete process.env.NANOBOSS_AGENT_MODEL;
    } else {
      process.env.NANOBOSS_AGENT_MODEL = originalModel;
    }
    if (originalCooperativeCancel === undefined) {
      delete process.env.MOCK_AGENT_COOPERATIVE_CANCEL;
    } else {
      process.env.MOCK_AGENT_COOPERATIVE_CANCEL = originalCooperativeCancel;
    }
  }
}

describe("ProcedureDispatchJobManager", () => {
  test("marks queued jobs as failed when their worker pid is dead", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "nab-dispatch-jobs-"));
    mkdirSync(join(rootDir, "procedure-dispatch-jobs"), { recursive: true });

    const dispatchId = "dispatch-dead-worker";
    writeFileSync(buildProcedureDispatchJobPath(rootDir, dispatchId), `${JSON.stringify({
      dispatchId,
      sessionId: "session-1",
      procedure: "research",
      prompt: "investigate",
      status: "queued",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z",
      dispatchCorrelationId: "corr-1",
      workerPid: 999_999,
    }, null, 2)}\n`);

    const status = await createManager(rootDir).status(dispatchId);

    expect(status.status).toBe("failed");
    expect(status.error).toContain("worker exited before completing");
    expect(status.error).toContain("999999");
  });

  test("does not mark queued jobs as dead when pid checks are denied", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "nab-dispatch-jobs-eperm-"));
    mkdirSync(join(rootDir, "procedure-dispatch-jobs"), { recursive: true });

    const dispatchId = "dispatch-permission-denied";
    writeFileSync(buildProcedureDispatchJobPath(rootDir, dispatchId), `${JSON.stringify({
      dispatchId,
      sessionId: "session-1",
      procedure: "research",
      prompt: "investigate",
      status: "queued",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z",
      dispatchCorrelationId: "corr-eperm",
      workerPid: 123_456,
    }, null, 2)}\n`);

    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      expect(pid).toBe(123_456);
      expect(signal).toBe(0);
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof process.kill;

    try {
      const status = await createManager(rootDir).status(dispatchId);
      expect(status.status).toBe("queued");
      expect(status.error).toBeUndefined();
    } finally {
      process.kill = originalKill;
    }
  });

  test("cancelByCorrelationId cancels an in-flight worker cooperatively", async () => {
    await withMockAgentEnv(async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "nab-dispatch-jobs-cancel-"));
      const dispatchId = "dispatch-cancel";
      const dispatchCorrelationId = "corr-cancel";
      mkdirSync(join(rootDir, "procedure-dispatch-jobs"), { recursive: true });
      const manager = createManager(rootDir, async () => ({
        get: (name) => name === "review"
          ? {
              name: "review",
              description: "test review",
              async execute(_prompt, ctx) {
                await ctx.callAgent("cooperative cancel demo", { stream: false });
                return { display: "done" };
              },
            }
          : undefined,
        register() {},
        async loadProcedureFromPath() {
          throw new Error("Not implemented in test");
        },
        async persist() {
          throw new Error("Not implemented in test");
        },
        toAvailableCommands: () => [],
      }));
      writeFileSync(buildProcedureDispatchJobPath(rootDir, dispatchId), `${JSON.stringify({
        dispatchId,
        sessionId: "session-1",
        procedure: "review",
        prompt: "please review",
        status: "queued",
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:00:00.000Z",
        dispatchCorrelationId,
      }, null, 2)}\n`);

      const runPromise = manager.run(dispatchId);
      await Bun.sleep(150);
      manager.cancelByCorrelationId(dispatchCorrelationId);
      await runPromise;

      const status = await manager.status(dispatchId);
      expect(status.status).toBe("cancelled");
      expect(status.error).toBe("Stopped.");
      expect(isProcedureDispatchCancellationRequested(rootDir, dispatchCorrelationId)).toBe(true);
      clearProcedureDispatchCancellation(rootDir, dispatchCorrelationId);
    });
  }, 30_000);
});
