import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";

import { getAgentTranscriptDir, resolveDownstreamAgentConfig } from "./config.ts";
import type { AgentResult, CallAgentOptions, CallAgentTransport, TypeDescriptor } from "./types.ts";

export const MAX_PARSE_RETRIES = 2;

export async function callAgent<T = string>(
  prompt: string,
  descriptor?: TypeDescriptor<T>,
  options: CallAgentOptions = {},
  transport: CallAgentTransport = defaultTransport,
): Promise<AgentResult<T>> {
  const startedAt = Date.now();
  let lastError = "";
  let lastRaw = "";

  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt += 1) {
    const fullPrompt = buildPrompt(prompt, descriptor, attempt, lastError, lastRaw);
    const response = await transport.invoke(fullPrompt, options);

    lastRaw = response.raw;

    if (!descriptor) {
      return {
        value: response.raw as T,
        logFile: response.logFile,
        durationMs: Date.now() - startedAt,
        raw: response.raw,
      };
    }

    try {
      const parsed = parseAgentResponse(response.raw, descriptor);
      return {
        value: parsed,
        logFile: response.logFile,
        durationMs: Date.now() - startedAt,
        raw: response.raw,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    `callAgent failed after ${MAX_PARSE_RETRIES + 1} attempts: ${lastError}`,
  );
}

export function buildPrompt<T>(
  prompt: string,
  descriptor: TypeDescriptor<T> | undefined,
  attempt = 0,
  lastError = "",
  lastRaw = "",
): string {
  if (!descriptor) {
    return prompt;
  }

  const parts = [
    prompt,
    "",
    "Respond ONLY with valid JSON matching this schema.",
    "Do not use markdown or code fences.",
    JSON.stringify(descriptor.schema, null, 2),
  ];

  if (attempt > 0) {
    parts.push(
      "",
      `Your previous response was invalid: ${lastError}`,
      "Previous response:",
      lastRaw,
      "Try again with JSON only.",
    );
  }

  return parts.join("\n");
}

export function sanitizeJsonResponse(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function parseAgentResponse<T>(
  raw: string,
  descriptor: TypeDescriptor<T>,
): T {
  const sanitized = sanitizeJsonResponse(raw);
  const directParse = tryParseAndValidate(sanitized, descriptor);
  if (directParse.status === "valid") {
    return directParse.value;
  }

  if (directParse.status === "invalid") {
    throw new Error("JSON parsed but failed schema validation");
  }

  let foundInvalidJson = false;

  for (const fragment of extractTopLevelJsonFragments(sanitized)) {
    const fragmentParse = tryParseAndValidate(fragment, descriptor);
    if (fragmentParse.status === "valid") {
      return fragmentParse.value;
    }
    if (fragmentParse.status === "invalid") {
      foundInvalidJson = true;
    }
  }

  if (foundInvalidJson) {
    throw new Error("JSON parsed but failed schema validation");
  }

  throw directParse.error;
}

function tryParseAndValidate<T>(
  candidate: string,
  descriptor: TypeDescriptor<T>,
):
  | { status: "valid"; value: T }
  | { status: "invalid" }
  | { status: "parse_error"; error: Error } {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!descriptor.validate(parsed)) {
      return { status: "invalid" };
    }
    return { status: "valid", value: parsed };
  } catch (error) {
    return {
      status: "parse_error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function extractTopLevelJsonFragments(raw: string): string[] {
  const fragments: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== "{" && char !== "[") {
      continue;
    }

    const end = findJsonValueEnd(raw, index);
    if (end !== undefined) {
      fragments.push({ start: index, end });
    }
  }

  return fragments
    .filter((fragment, index) =>
      !fragments.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          candidate.start <= fragment.start &&
          candidate.end >= fragment.end &&
          (candidate.start !== fragment.start || candidate.end !== fragment.end),
      ),
    )
    .sort((left, right) => right.start - left.start)
    .map((fragment) => raw.slice(fragment.start, fragment.end));
}

function findJsonValueEnd(raw: string, start: number): number | undefined {
  const stack = [raw[start] === "{" ? "}" : "]"];
  let inString = false;
  let escaping = false;

  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }

    if (char === "[") {
      stack.push("]");
      continue;
    }

    if (char !== "}" && char !== "]") {
      continue;
    }

    if (char !== stack.at(-1)) {
      return undefined;
    }

    stack.pop();
    if (stack.length === 0) {
      return index + 1;
    }
  }

  return undefined;
}

const defaultTransport: CallAgentTransport = {
  async invoke(prompt, options) {
    return runAcpPrompt(prompt, options);
  },
};

async function runAcpPrompt(
  prompt: string,
  options: CallAgentOptions,
): Promise<{ raw: string; logFile?: string; updates: acp.SessionUpdate[] }> {
  const config = options.config ?? resolveDownstreamAgentConfig();
  const cwd = config.cwd ?? process.cwd();
  const transcriptPath = createTranscriptPath();
  const updates: acp.SessionUpdate[] = [];
  let raw = "";

  mkdirSync(getAgentTranscriptDir(), { recursive: true });
  appendAgentTranscript(
    transcriptPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "spawn",
      command: config.command,
      args: config.args,
      cwd,
    }),
  );

  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(config.command, config.args, {
    cwd,
    env: {
      ...process.env,
      ...config.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    appendAgentTranscript(
      transcriptPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        stream: "stderr",
        text: chunk.toString(),
      }),
    );
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );

  let sessionId: acp.SessionId | undefined;

  const client: acp.Client = {
    async requestPermission(params) {
      const selected =
        params.options.find((option) => option.kind.startsWith("allow")) ??
        params.options[0];

      if (!selected) {
        return { outcome: { outcome: "cancelled" } };
      }

      appendAgentTranscript(
        transcriptPath,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "permission",
          toolCall: params.toolCall,
          selected: selected.optionId,
        }),
      );

      return {
        outcome: {
          outcome: "selected",
          optionId: selected.optionId,
        },
      };
    },
    async sessionUpdate(params) {
      updates.push(params.update);
      appendAgentTranscript(
        transcriptPath,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "session_update",
          update: params.update,
        }),
      );

      if (
        params.update.sessionUpdate === "agent_message_chunk" &&
        params.update.content.type === "text"
      ) {
        raw += params.update.content.text;
      }

      await options.onUpdate?.(params.update);
    },
  };

  const connection = new acp.ClientSideConnection(() => client, stream);
  const abortListener = () => {
    if (sessionId !== undefined) {
      void connection.cancel({ sessionId });
    }
    child.kill();
  };

  options.signal?.addEventListener("abort", abortListener);

  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const session = await connection.newSession({
      cwd,
      mcpServers: [],
    });
    sessionId = session.sessionId;

    await connection.prompt({
      sessionId,
      prompt: [
        {
          type: "text",
          text: prompt,
        },
      ],
    });

    return {
      raw,
      logFile: transcriptPath,
      updates,
    };
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
    child.kill();
  }
}

function createTranscriptPath(): string {
  return join(getAgentTranscriptDir(), `${crypto.randomUUID()}.jsonl`);
}

function appendAgentTranscript(path: string, line: string): void {
  appendFileSync(path, `${line}\n`, "utf8");
}
