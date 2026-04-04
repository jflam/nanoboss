import { describeE2E, reservePort, spawnNanoboss, waitForHealth, waitForMatch } from "./helpers.ts";
import {
  createHttpSession,
  sendSessionPrompt,
  startSessionEventStream,
} from "../../src/http/client.ts";
import type { FrontendEventEnvelope } from "../../src/http/frontend-events.ts";
import { expect, test } from "bun:test";

interface AgentFixture {
  name: string;
  command: string;
  args: string[];
  model?: string;
}

const AGENTS: AgentFixture[] = [
  {
    name: "claude",
    command: "claude-code-acp",
    args: [],
  },
  {
    name: "gemini",
    command: "gemini",
    args: ["--acp"],
  },
  {
    name: "codex",
    command: "codex-acp",
    args: [],
  },
  {
    name: "copilot",
    command: "copilot",
    args: ["--acp", "--allow-all-tools"],
  },
];

describeE2E("/default multi-turn history (real agents)", () => {
  for (const agent of AGENTS) {
    test(
      `${agent.name} carries /default history across turns`,
      async () => {
        const port = await reservePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const server = spawnNanoboss([
          "http",
          "--port",
          String(port),
        ], realAgentEnv(agent));

        try {
          await waitForHealth(baseUrl, 20_000);

          const session = await createHttpSession(baseUrl, process.cwd());
          const events: FrontendEventEnvelope[] = [];
          const errors: string[] = [];
          const stream = startSessionEventStream({
            baseUrl,
            sessionId: session.sessionId,
            onEvent(event) {
              events.push(event);
            },
            onError(error) {
              errors.push(error instanceof Error ? error.message : String(error));
            },
          });

          try {
            await sendSessionPrompt(
              baseUrl,
              session.sessionId,
              "What is 2 + 2? Reply with only the number.",
            );
            await waitForCompletedRuns(events, 1);

            const firstDisplay = completedRuns(events)[0]?.data.display ?? "";
            expect(firstDisplay).toMatch(/\b4\b/);

            await sendSessionPrompt(
              baseUrl,
              session.sessionId,
              "Add 3 to the previous result. Reply with only the number.",
            );
            await waitForCompletedRuns(events, 2);

            const secondDisplay = completedRuns(events)[1]?.data.display ?? "";
            expect(secondDisplay).toMatch(/\b7\b/);
            expect(errors).toEqual([]);
          } finally {
            stream.close();
          }
        } finally {
          await server.stop();
        }
      },
      180_000,
    );
  }
});

function completedRuns(events: FrontendEventEnvelope[]) {
  return events.filter((event) => event.type === "run_completed");
}

async function waitForCompletedRuns(
  events: FrontendEventEnvelope[],
  count: number,
): Promise<void> {
  await waitForMatch(() => String(completedRuns(events).length), String(count), 90_000);
}

function realAgentEnv(agent: AgentFixture): Record<string, string> {
  return {
    ...process.env,
    NANOBOSS_AGENT_CMD: agent.command,
    NANOBOSS_AGENT_ARGS: JSON.stringify(agent.args),
    ...(agent.model ? { NANOBOSS_AGENT_MODEL: agent.model } : {}),
    NANOBOSS_HTTP_IDLE_TIMEOUT_SECONDS: "5",
    NANOBOSS_SSE_KEEPALIVE_MS: "100",
  } as Record<string, string>;
}
