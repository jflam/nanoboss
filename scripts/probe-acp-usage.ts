import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { collectTokenSnapshot } from "@nanoboss/agent-acp";
import type { AgentTokenSnapshot, DownstreamAgentProvider, DownstreamAgentSelection } from "@nanoboss/procedure-sdk";
import { resolveDownstreamAgentConfig } from "@nanoboss/procedure-engine";

interface ProbeArgs {
  provider: DownstreamAgentProvider;
  model?: string;
  prompts: string[];
  cwd?: string;
}

interface TurnProbeResult {
  turn: number;
  prompt: string;
  response: acp.PromptResponse;
  text: string;
  updates: acp.SessionUpdate[];
  tokenSnapshot?: AgentTokenSnapshot;
}

const DEFAULT_PROMPTS = [
  [
    "Remember the marker TOKEN-PROBE-ALPHA.",
    "Then reply with exactly ACK-1 and nothing else.",
    "Padding starts now:",
    Array.from({ length: 200 }, (_, i) => `block-${i.toString().padStart(3, "0")} TOKEN-PROBE-ALPHA`).join(" "),
  ].join("\n\n"),
  "Reply with exactly ACK-2 and nothing else.",
  "Reply with exactly ACK-3 and nothing else.",
];

function parseArgs(argv: string[]): ProbeArgs {
  const positionals: string[] = [];
  const prompts: string[] = [];
  let cwd: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--prompt") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value after --prompt");
      }
      prompts.push(value);
      index += 1;
      continue;
    }
    if (arg === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value after --cwd");
      }
      cwd = value;
      index += 1;
      continue;
    }
    positionals.push(arg);
  }

  const [provider, model] = positionals;
  if (provider !== "claude" && provider !== "gemini" && provider !== "codex" && provider !== "copilot") {
    throw new Error("Usage: bun run scripts/probe-acp-usage.ts <claude|gemini|codex|copilot> [model] [--prompt text]... [--cwd path]");
  }

  return {
    provider,
    model,
    prompts: prompts.length > 0 ? prompts : DEFAULT_PROMPTS,
    cwd,
  };
}

function collectText(updates: acp.SessionUpdate[]): string {
  return updates
    .flatMap((update) => {
      if (update.sessionUpdate !== "agent_message_chunk") {
        return [] as string[];
      }
      return update.content.type === "text" ? [update.content.text] : [];
    })
    .join("");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selection: DownstreamAgentSelection = {
    provider: args.provider,
    model: args.model,
  };
  const config = resolveDownstreamAgentConfig(args.cwd ?? process.cwd(), selection);

  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: {
      ...process.env,
      ...config.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${String(chunk)}`;
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );

  let activeUpdates: acp.SessionUpdate[] = [];

  const connection = new acp.ClientSideConnection(
    () => ({
      async requestPermission(params) {
        const selected = params.options.find((option) => option.kind.startsWith("allow")) ?? params.options[0];
        if (!selected) {
          return { outcome: { outcome: "cancelled" } };
        }
        return {
          outcome: {
            outcome: "selected",
            optionId: selected.optionId,
          },
        };
      },
      async sessionUpdate(params) {
        activeUpdates.push(params.update);
      },
    }),
    stream,
  );

  try {
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const created = await connection.newSession({
      cwd: config.cwd ?? process.cwd(),
      mcpServers: [],
    });

    if (config.model) {
      await connection.unstable_setSessionModel({
        sessionId: created.sessionId,
        modelId: config.model,
      });
    }

    if (config.reasoningEffort) {
      await connection.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: "reasoning_effort",
        value: config.reasoningEffort,
      });
    }

    const turns: TurnProbeResult[] = [];

    for (let index = 0; index < args.prompts.length; index += 1) {
      activeUpdates = [];
      const prompt = args.prompts[index];
      if (prompt === undefined) {
        throw new Error(`Missing prompt at index ${index}`);
      }
      const response = await connection.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });

      turns.push({
        turn: index + 1,
        prompt,
        response,
        text: collectText(activeUpdates),
        updates: activeUpdates,
        tokenSnapshot: await collectTokenSnapshot({
          childPid: child.pid,
          config,
          promptResponse: response,
          sessionId: created.sessionId,
          updates: activeUpdates,
        }),
      });
    }

    const result = {
      provider: args.provider,
      requestedModel: args.model,
      resolvedConfig: {
        command: config.command,
        args: config.args,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        cwd: config.cwd,
      },
      capabilities: initialized.agentCapabilities,
      sessionId: created.sessionId,
      turns: turns.map((turn) => ({
        turn: turn.turn,
        promptPreview: turn.prompt.slice(0, 120),
        response: turn.response,
        text: turn.text,
        updateKinds: turn.updates.map((update) => update.sessionUpdate),
        usageUpdates: turn.updates.filter((update) => update.sessionUpdate === "usage_update"),
        tokenSnapshot: turn.tokenSnapshot,
        updateCount: turn.updates.length,
      })),
      stderr: stderr.trim() || undefined,
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    child.kill();
  }
}

await main();
