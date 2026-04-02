import type { FrontendEventEnvelope } from "./frontend-events.ts";
import type { DownstreamAgentSelection } from "./types.ts";

export interface ServerHealthResponse {
  status: string;
  buildLabel?: string;
  buildCommit?: string;
  pid?: number;
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
  defaultAgentSelection?: DownstreamAgentSelection;
}

interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

export interface SessionStreamHandle {
  close(): void;
}

export async function getServerHealth(baseUrl: string): Promise<ServerHealthResponse> {
  const response = await fetch(new URL("/v1/health", baseUrl));
  if (!response.ok) {
    throw new Error(`Failed to get server health: ${response.status}`);
  }

  return response.json() as Promise<ServerHealthResponse>;
}

export async function requestServerShutdown(baseUrl: string): Promise<void> {
  const response = await fetch(new URL("/v1/admin/shutdown", baseUrl), {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to request server shutdown: ${response.status}`);
  }
}

export async function createHttpSession(
  baseUrl: string,
  cwd: string,
  defaultAgentSelection?: DownstreamAgentSelection,
): Promise<SessionResponse> {
  const response = await fetch(new URL("/v1/sessions", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd, defaultAgentSelection }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }

  return response.json() as Promise<SessionResponse>;
}

export async function sendSessionPrompt(
  baseUrl: string,
  sessionId: string,
  prompt: string,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/sessions/${sessionId}/prompts`, baseUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to send prompt: ${response.status}`);
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

  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const url = new URL(`/v1/sessions/${params.sessionId}/stream`, params.baseUrl);
        if (afterSeq >= 0) {
          url.searchParams.set("after_seq", String(afterSeq));
        }

        const response = await fetch(url, {
          headers: {
            Accept: "text/event-stream",
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
        });
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
  };
}

export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) {
          break;
        }

        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseMessage(rawEvent);
        if (parsed) {
          onMessage(parsed);
        }
      }
    }

    buffer += decoder.decode();
    const parsed = parseSseMessage(buffer.trim());
    if (parsed) {
      onMessage(parsed);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseMessage(rawEvent: string): SseMessage | undefined {
  const trimmed = rawEvent.trim();
  if (!trimmed || trimmed.startsWith(":")) {
    return undefined;
  }

  const data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;

  for (const line of trimmed.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

    switch (field) {
      case "id":
        id = value;
        break;
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      default:
        break;
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return {
    id,
    event,
    data: data.join("\n"),
  };
}
