import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSession } from "@nanoboss/agent-acp";
import { NanobossService } from "@nanoboss/app-runtime";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import type { DownstreamAgentConfig } from "../../src/core/types.ts";

function createMockConfig(
  cwd: string,
  options: {
    supportLoadSession: boolean;
    sessionStoreDir: string;
    provider?: DownstreamAgentConfig["provider"];
    model?: string;
    extraEnv?: Record<string, string | undefined>;
  },
): DownstreamAgentConfig {
  const env: Record<string, string> = {
    MOCK_AGENT_SUPPORT_LOAD_SESSION: options.supportLoadSession ? "1" : "0",
    MOCK_AGENT_SESSION_STORE_DIR: options.sessionStoreDir,
  };
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return {
    command: "bun",
    args: ["run", "tests/fixtures/mock-agent.ts"],
    cwd,
    env,
    provider: options.provider,
    model: options.model,
  };
}

describe("/default native session continuity", () => {
  test(
    "first prompt persists an ACP session id and second prompt reuses the live session",
    async () => {
      const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-default-live-"));
      const conversation = createAgentSession({
        config: createMockConfig(process.cwd(), {
          supportLoadSession: true,
          sessionStoreDir,
        }),
      });

      try {
        const first = await conversation.prompt("what is 2+2");
        expect(first.raw).toBe("4");
        const acpSessionId = conversation.sessionId;
        expect(acpSessionId).toBeTruthy();

        const second = await conversation.prompt("add 3 to result");
        expect(second.raw).toBe("7");
        expect(conversation.sessionId).toBe(acpSessionId);
      } finally {
        conversation.close();
      }
    },
    30_000,
  );

  test(
    "falls back to session/load when the live session is gone",
    async () => {
      const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-default-load-"));
      const conversation = createAgentSession({
        config: createMockConfig(process.cwd(), {
          supportLoadSession: true,
          sessionStoreDir,
        }),
      });

      try {
        await conversation.prompt("what is 2+2");
        const acpSessionId = conversation.sessionId;
        expect(acpSessionId).toBeTruthy();

        conversation.close();

        const second = await conversation.prompt("add 3 to result");
        expect(second.raw).toBe("7");
        expect(conversation.sessionId).toBe(acpSessionId);
      } finally {
        conversation.close();
      }
    },
    30_000,
  );

  test(
    "starts fresh when native resume is unavailable",
    async () => {
      const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-default-fresh-"));
      const conversation = createAgentSession({
        config: createMockConfig(process.cwd(), {
          supportLoadSession: false,
          sessionStoreDir,
        }),
      });

      try {
        await conversation.prompt("what is 2+2");
        const firstSessionId = conversation.sessionId;
        expect(firstSessionId).toBeTruthy();

        conversation.close();

        const second = await conversation.prompt("add 3 to result");
        expect(second.raw).toBe("no prior result");
        expect(conversation.sessionId).toBeTruthy();
        expect(conversation.sessionId).not.toBe(firstSessionId);
      } finally {
        conversation.close();
      }
    },
    30_000,
  );

  test(
    "changing the default agent config resets native session continuity",
    async () => {
      const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-default-reset-"));
      const conversation = createAgentSession({
        config: createMockConfig(process.cwd(), {
          supportLoadSession: true,
          sessionStoreDir,
        }),
      });

      try {
        await conversation.prompt("what is 2+2");
        const firstSessionId = conversation.sessionId;
        expect(firstSessionId).toBeTruthy();

        conversation.updateConfig({
          ...createMockConfig(process.cwd(), {
            supportLoadSession: true,
            sessionStoreDir,
          }),
          provider: "claude",
        });

        expect(conversation.sessionId).toBeUndefined();

        const second = await conversation.prompt("add 3 to result");
        expect(second.raw).toBe("no prior result");
        expect(conversation.sessionId).toBeTruthy();
        expect(conversation.sessionId).not.toBe(firstSessionId);
      } finally {
        conversation.close();
      }
    },
    30_000,
  );

  test(
    "ignores late previous-turn chunks when a live session is reused",
    async () => {
      const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-default-late-chunk-"));
      const conversation = createAgentSession({
        config: createMockConfig(process.cwd(), {
          supportLoadSession: true,
          sessionStoreDir,
          extraEnv: {
            MOCK_AGENT_LATE_PREVIOUS_TURN_CHUNK_MS: "25",
          },
        }),
      });

      try {
        const first = await conversation.prompt("what is 2+2");
        expect(first.raw).toContain("4");
        expect(first.raw).toContain("late previous turn");

        const second = await conversation.prompt("simulate-long-run add 3 to result");
        expect(second.raw).toBe("7");
        expect(second.raw).not.toContain("late previous turn");
      } finally {
        conversation.close();
      }
    },
    30_000,
  );

  test(
    "service publishes token usage from copilot logs after downstream tool calls",
    async () => {
      const previousHome = process.env.HOME;
      process.env.HOME = mkdtempSync(join(tmpdir(), "nab-default-copilot-home-"));

      try {
        const registry = new ProcedureRegistry({ procedureRoots: [mkdtempSync(join(tmpdir(), "nab-default-copilot-registry-"))] });
        registry.loadBuiltins();

        const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-default-copilot-agent-"));
        const service = new NanobossService(
          registry,
          (cwd) => createMockConfig(cwd, {
            supportLoadSession: true,
            sessionStoreDir,
            provider: "copilot",
            extraEnv: {
              MOCK_AGENT_WRITE_COPILOT_LOG: "1",
            },
          }),
        );
        const session = service.createSession({ cwd: process.cwd() });

        try {
          await service.promptSession(session.sessionId, "nested tool trace demo");

          const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
          const tokenUsageIndex = events.findIndex((event) =>
            event.type === "token_usage"
            && event.data.sourceUpdate === "tool_call_update"
            && event.data.toolCallId !== undefined
          );
          expect(tokenUsageIndex).toBeGreaterThanOrEqual(0);

          const tokenEvent = events[tokenUsageIndex];
          expect(tokenEvent?.type).toBe("token_usage");
          if (tokenEvent?.type !== "token_usage") {
            throw new Error("Expected token_usage event");
          }

          expect(tokenEvent.data.usage).toMatchObject({
            provider: "copilot",
            source: "copilot_log",
            currentContextTokens: 24152,
            maxContextTokens: 272000,
            inputTokens: 19428,
            outputTokens: 92,
          });

          const completedIndex = events.findIndex((event) => event.type === "run_completed");
          expect(completedIndex).toBeGreaterThan(tokenUsageIndex);
        } finally {
          service.destroySession(session.sessionId);
        }
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
      }
    },
    30_000,
  );

  test(
    "the built-in /default command is conversational across turns",
    async () => {
      const registry = new ProcedureRegistry({ procedureRoots: [mkdtempSync(join(tmpdir(), "nab-default-registry-"))] });
      registry.loadBuiltins();

      const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-default-service-"));
      const service = new NanobossService(
        registry,
        (cwd) => createMockConfig(cwd, {
          supportLoadSession: true,
          sessionStoreDir,
        }),
      );
      const session = service.createSession({ cwd: process.cwd() });

      try {
        await service.promptSession(session.sessionId, "what is 2+2");
        await service.promptSession(session.sessionId, "add 3 to result");

        const completed = (service.getSessionEvents(session.sessionId)?.after(-1) ?? [])
          .filter((event) => event.type === "run_completed");

        expect(completed).toHaveLength(2);
        expect(completed[0]?.data.display).toBe("4");
        expect(completed[1]?.data.display).toBe("7");
      } finally {
        service.destroySession(session.sessionId);
      }
    },
    30_000,
  );

  test(
    "service resume restores native default-session continuity after a restart",
    async () => {
      const previousHome = process.env.HOME;
      process.env.HOME = mkdtempSync(join(tmpdir(), "nab-default-resume-home-"));

      try {
        const registry = new ProcedureRegistry({ procedureRoots: [mkdtempSync(join(tmpdir(), "nab-default-resume-registry-"))] });
        registry.loadBuiltins();

        const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-default-resume-agent-"));
        const createService = () => new NanobossService(
          registry,
          (cwd) => createMockConfig(cwd, {
            supportLoadSession: true,
            sessionStoreDir,
          }),
        );

        const service = createService();
        const session = service.createSession({ cwd: process.cwd() });

        try {
          await service.promptSession(session.sessionId, "what is 2+2");
        } finally {
          service.destroySession(session.sessionId);
        }

        const resumedService = createService();
        const resumed = resumedService.resumeSession({
          sessionId: session.sessionId,
          cwd: process.cwd(),
        });

        try {
          await resumedService.promptSession(resumed.sessionId, "add 3 to result");

          const completed = (resumedService.getSessionEvents(resumed.sessionId)?.after(-1) ?? [])
            .filter((event) => event.type === "run_completed");

          expect(completed.length).toBeGreaterThanOrEqual(1);
          expect(completed.at(-1)?.data.display).toBe("7");
        } finally {
          resumedService.destroySession(resumed.sessionId);
        }
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
      }
    },
    30_000,
  );
});
