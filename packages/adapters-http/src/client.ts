import {
  normalizePromptInput,
  type DownstreamAgentSelection,
  type PromptInput,
} from "@nanoboss/procedure-sdk";
import type { FrontendEventEnvelope } from "./event-mapping.ts";
import { parseSseStream } from "./sse-stream.ts";

export interface ServerHealthResponse {
  status: string;
  buildLabel?: string;
  buildCommit?: string;
  pid?: number;
  mode?: "private" | "shared";
  cwd?: string;
  repoRoot?: string;
  workspaceKey?: string;
  proceduresFingerprint?: string;
}

interface SessionResponse {
  sessionId: string;
  cwd: string;
  commands: Array<{
    name: string;
    description: string;
    inputHint?: string;
  }>;
  buildLabel: string;
  agentLabel: string;
  autoApprove: boolean;
  defaultAgentSelection?: DownstreamAgentSelection;
}

export interface SessionStreamHandle {
  close(): void;
  closed: Promise<void>;
}

export async function getServerHealth(baseUrl: string): Promise<ServerHealthResponse> {
  const response = await fetch(new URL("/v1/health", baseUrl), {
    headers: {
      connection: "close",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to get server health: ${response.status}`);
  }

  return response.json() as Promise<ServerHealthResponse>;
}

export async function requestServerShutdown(baseUrl: string): Promise<void> {
  const response = await fetch(new URL("/v1/admin/shutdown", baseUrl), {
    method: "POST",
    headers: {
      connection: "close",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to request server shutdown: ${response.status}`);
  }
}

export async function createHttpSession(
  baseUrl: string,
  cwd: string,
  autoApprove?: boolean,
  defaultAgentSelection?: DownstreamAgentSelection,
): Promise<SessionResponse> {
  const response = await fetch(new URL("/v1/sessions", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({ cwd, autoApprove, defaultAgentSelection }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }

  return response.json() as Promise<SessionResponse>;
}

export async function resumeHttpSession(
  baseUrl: string,
  sessionId: string,
  cwd: string,
  autoApprove?: boolean,
  defaultAgentSelection?: DownstreamAgentSelection,
): Promise<SessionResponse> {
  const response = await fetch(new URL("/v1/sessions/resume", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({ sessionId, cwd, autoApprove, defaultAgentSelection }),
  });

  if (!response.ok) {
    throw new Error(`Failed to resume session: ${response.status}`);
  }

  return response.json() as Promise<SessionResponse>;
}

export async function setSessionAutoApprove(
  baseUrl: string,
  sessionId: string,
  enabled: boolean,
): Promise<SessionResponse> {
  const response = await fetch(new URL(`/v1/sessions/${sessionId}/auto-approve`, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({ enabled }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update auto-approve: ${response.status}`);
  }

  return response.json() as Promise<SessionResponse>;
}

export async function sendSessionPrompt(
  baseUrl: string,
  sessionId: string,
  prompt: string | PromptInput,
): Promise<void> {
  const promptInput = normalizePromptInput(prompt);
  const response = await fetch(
    new URL(`/v1/sessions/${sessionId}/prompts`, baseUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({ promptInput }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to send prompt: ${response.status}`);
  }
}

export async function cancelSessionRun(
  baseUrl: string,
  sessionId: string,
  runId: string,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/sessions/${sessionId}/cancel`, baseUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({ runId }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to cancel run: ${response.status}`);
  }
}

export async function cancelSessionContinuation(
  baseUrl: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/sessions/${sessionId}/continuation-cancel`, baseUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to cancel continuation: ${response.status}`);
  }
}

export function startSessionEventStream(params: {
  baseUrl: string;
  sessionId: string;
  onEvent: (event: FrontendEventEnvelope) => void;
  onError?: (error: unknown) => void;
}): SessionStreamHandle {
  const controller = new AbortController();
  let afterSeq = -1;

  const closed = (async () => {
    while (!controller.signal.aborted) {
      try {
        const url = new URL(`/v1/sessions/${params.sessionId}/stream`, params.baseUrl);
        if (afterSeq >= 0) {
          url.searchParams.set("after_seq", String(afterSeq));
        }

        const response = await fetch(url, {
          headers: {
            Accept: "text/event-stream",
            connection: "close",
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Failed to connect to stream: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("SSE response had no body");
        }

        await parseSseStream(response.body, (message) => {
          const parsed = JSON.parse(message.data) as FrontendEventEnvelope;
          afterSeq = Math.max(afterSeq, parsed.seq);
          params.onEvent(parsed);
        }, controller.signal);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        params.onError?.(error);
        await Bun.sleep(250);
      }
    }
  })();

  return {
    close() {
      controller.abort();
    },
    closed,
  };
}
