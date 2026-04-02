import type * as acp from "@agentclientprotocol/sdk";

import {
  applyAcpSessionConfig,
  closeAcpConnection,
  openAcpConnection,
} from "./acp-runtime.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import { buildSessionMcpServers } from "./mcp-attachment.ts";
import { SessionStore, summarizeText } from "./session-store.ts";
import type {
  AgentRunResult,
  CallAgentOptions,
  CallAgentTransport,
  KernelValue,
  TypeDescriptor,
} from "./types.ts";

export const MAX_PARSE_RETRIES = 2;

interface InvokedAgentResult<T> {
  data: T;
  logFile?: string;
  durationMs: number;
  raw: string;
  updates: acp.SessionUpdate[];
}

export async function callAgent<T = string>(
  prompt: string,
  descriptor?: TypeDescriptor<T>,
  options: CallAgentOptions = {},
  transport: CallAgentTransport = defaultTransport,
): Promise<AgentRunResult<T & KernelValue>> {
  const result = await invokeAgent(prompt, descriptor, options, transport);
  const cwd = options.config?.cwd ?? process.cwd();
  const store = new SessionStore({
    sessionId: crypto.randomUUID(),
    cwd,
  });
  const cell = store.startCell({
    procedure: "callAgent",
    input: prompt,
    kind: "agent",
  });
  const finalized = store.finalizeCell(cell, {
    data: result.data as T & KernelValue,
    display: result.raw,
    summary: summarizeStandaloneResult(result.data, result.raw),
  }, {
    stream: collectStreamText(result.updates),
    raw: result.raw,
  });

  return {
    ...finalized,
    durationMs: result.durationMs,
    raw: result.raw,
    logFile: result.logFile,
  };
}

export async function invokeAgent<T = string>(
  prompt: string,
  descriptor?: TypeDescriptor<T>,
  options: CallAgentOptions = {},
  transport: CallAgentTransport = defaultTransport,
): Promise<InvokedAgentResult<T>> {
  const startedAt = Date.now();
  let lastError = "";
  let lastRaw = "";

  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt += 1) {
    const fullPrompt = buildPrompt(
      prompt,
      descriptor,
      attempt,
      lastError,
      lastRaw,
      options.namedRefs,
    );
    const response = await transport.invoke(fullPrompt, options);

    lastRaw = response.raw;

    if (!descriptor) {
      return {
        data: response.raw as T,
        logFile: response.logFile,
        durationMs: Date.now() - startedAt,
        raw: response.raw,
        updates: response.updates,
      };
    }

    try {
      const parsed = parseAgentResponse(response.raw, descriptor);
      return {
        data: parsed,
        logFile: response.logFile,
        durationMs: Date.now() - startedAt,
        raw: response.raw,
        updates: response.updates,
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
  namedRefs?: Record<string, unknown>,
): string {
  const parts = [prompt];

  if (namedRefs && Object.keys(namedRefs).length > 0) {
    parts.push(
      "",
      "Use the following named refs as source material when the prompt mentions them.",
      "Each ref already contains the resolved value of a prior durable session reference.",
    );

    for (const [name, value] of Object.entries(namedRefs)) {
      parts.push(
        "",
        `<ref name="${name}">`,
        serializeNamedRef(value),
        "</ref>",
      );
    }
  }

  if (!descriptor) {
    return parts.join("\n");
  }

  parts.push(
    "",
    "Respond ONLY with valid JSON matching this schema.",
    "Do not use markdown or code fences.",
    JSON.stringify(descriptor.schema, null, 2),
  );

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
  const state = await openAcpConnection(config);
  const updates: acp.SessionUpdate[] = [];
  let raw = "";
  let sessionId: acp.SessionId | undefined;

  state.setSessionUpdateHandler(async (params) => {
    updates.push(params.update);
    state.writeEvent({
      event: "session_update",
      update: params.update,
    });

    if (
      params.update.sessionUpdate === "agent_message_chunk" &&
      params.update.content.type === "text"
    ) {
      raw += params.update.content.text;
    }

    await options.onUpdate?.(params.update);
  });

  const abortListener = () => {
    if (sessionId !== undefined) {
      void state.connection.cancel({ sessionId });
    }
    closeAcpConnection(state);
  };

  options.signal?.addEventListener("abort", abortListener);

  try {
    const session = await state.connection.newSession({
      cwd: state.cwd,
      mcpServers: options.sessionMcp
        ? buildSessionMcpServers({
            config,
            sessionId: options.sessionMcp.sessionId,
            cwd: options.sessionMcp.cwd ?? state.cwd,
            rootDir: options.sessionMcp.rootDir,
          })
        : [],
    });
    sessionId = session.sessionId;

    await applyAcpSessionConfig(state.connection, sessionId, config);

    await state.connection.prompt({
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
      logFile: state.transcriptPath,
      updates,
    };
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
    closeAcpConnection(state);
  }
}

function serializeNamedRef(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "undefined";
  }

  const serialized = JSON.stringify(value, null, 2);
  return typeof serialized === "string" ? serialized : "[unserializable]";
}

function collectStreamText(updates: acp.SessionUpdate[]): string | undefined {
  let text = "";

  for (const update of updates) {
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
      continue;
    }

    text += update.content.text;
  }

  return text || undefined;
}

function summarizeStandaloneResult(data: unknown, raw: string): string | undefined {
  if (typeof data === "string") {
    return summarizeText(data);
  }

  return summarizeText(raw);
}
