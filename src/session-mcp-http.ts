import type * as acp from "@agentclientprotocol/sdk";

import {
  SESSION_MCP_SERVER_NAME,
  createSessionMcpApi,
  dispatchSessionMcpMethod,
} from "./session-mcp.ts";
import type { DownstreamAgentConfig } from "./types.ts";

interface SessionMcpAttachmentParams {
  config: DownstreamAgentConfig;
  sessionId: string;
  cwd: string;
  rootDir?: string;
}

interface LoopbackServerState {
  server: ReturnType<typeof Bun.serve>;
  url: string;
}

const SESSION_HTTP_SERVERS = new Map<string, LoopbackServerState>();

export function ensureSessionMcpHttpServer(
  params: SessionMcpAttachmentParams,
): acp.NewSessionRequest["mcpServers"][number] {
  let existing = SESSION_HTTP_SERVERS.get(params.sessionId);
  if (!existing) {
    const api = createSessionMcpApi({
      sessionId: params.sessionId,
      cwd: params.cwd,
      rootDir: params.rootDir,
    });

    const server = Bun.serve({
      port: 0,
      fetch: (request) => handleSessionMcpHttpRequest(api, request),
    });

    existing = {
      server,
      url: `http://127.0.0.1:${server.port}/mcp`,
    };
    SESSION_HTTP_SERVERS.set(params.sessionId, existing);
  }

  return {
    type: "http",
    name: SESSION_MCP_SERVER_NAME,
    url: existing.url,
    headers: [],
  };
}

export function disposeSessionMcpHttpServer(sessionId: string): void {
  const state = SESSION_HTTP_SERVERS.get(sessionId);
  if (!state) {
    return;
  }

  void state.server.stop(true);
  SESSION_HTTP_SERVERS.delete(sessionId);
}

async function handleSessionMcpHttpRequest(api: ReturnType<typeof createSessionMcpApi>, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") {
    return new Response("Not found", { status: 404 });
  }

  if (request.method === "GET") {
    return new Response("nanoboss session mcp", {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        allow: "GET, POST, OPTIONS",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const message = body as { id?: string | number | null; method?: string; params?: unknown };
  if (!message.method) {
    return jsonRpcError(message.id ?? null, -32600, "Invalid Request");
  }

  if (message.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }

  try {
    const result = dispatchSessionMcpMethod(api, message.method, message.params);
    return jsonRpcResult(message.id ?? null, result);
  } catch (error) {
    return jsonRpcError(
      message.id ?? null,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function jsonRpcError(id: string | number | null, code: number, message: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}
