import { getBuildLabel } from "./build-info.ts";
import { DEFAULT_HTTP_SERVER_PORT } from "./defaults.ts";
import type { FrontendEventEnvelope } from "./frontend-events.ts";
import { NanobossService } from "./service.ts";
import type { DownstreamAgentSelection } from "./types.ts";

export interface HttpServerOptions {
  port: number;
  idleTimeoutSeconds: number;
  sseKeepAliveMs: number;
}

export function parseHttpServerOptions(argv: string[]): HttpServerOptions {
  let port = Number(Bun.env.NANOBOSS_PORT ?? String(DEFAULT_HTTP_SERVER_PORT));
  const idleTimeoutSeconds = Number(Bun.env.NANOBOSS_HTTP_IDLE_TIMEOUT_SECONDS ?? "30");
  const sseKeepAliveMs = Number(Bun.env.NANOBOSS_SSE_KEEPALIVE_MS ?? "10000");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--port") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--port requires a value");
      }
      port = Number(next);
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    }
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port: ${String(port)}`);
  }

  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds <= 0) {
    throw new Error(`Invalid idle timeout: ${String(idleTimeoutSeconds)}`);
  }

  if (!Number.isFinite(sseKeepAliveMs) || sseKeepAliveMs <= 0) {
    throw new Error(`Invalid SSE keepalive: ${String(sseKeepAliveMs)}`);
  }

  return {
    port,
    idleTimeoutSeconds,
    sseKeepAliveMs,
  };
}

export async function runHttpServerCommand(argv: string[] = []): Promise<ReturnType<typeof Bun.serve>> {
  const options = parseHttpServerOptions(argv);
  const service = await NanobossService.create();
  const encoder = new TextEncoder();

  const server = Bun.serve({
    port: options.port,
    idleTimeout: options.idleTimeoutSeconds,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/v1/health") {
        return json({ status: "ok" });
      }

      if (request.method === "POST" && path === "/v1/sessions") {
        const body = await readJson<{ cwd?: string; defaultAgentSelection?: DownstreamAgentSelection }>(request);
        const session = service.createSession({
          cwd: body.cwd ?? process.cwd(),
          defaultAgentSelection: body.defaultAgentSelection,
        });
        return json(session, 201);
      }

      const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
        const session = service.getSession(sessionId);
        if (!session) {
          return error(404, `Unknown session: ${sessionId}`);
        }
        return json(session);
      }

      const promptMatch = path.match(/^\/v1\/sessions\/([^/]+)\/prompts$/);
      if (request.method === "POST" && promptMatch) {
        const sessionId = decodeURIComponent(promptMatch[1] ?? "");
        const session = service.getSession(sessionId);
        if (!session) {
          return error(404, `Unknown session: ${sessionId}`);
        }

        const body = await readJson<{ prompt?: string }>(request);
        const prompt = body.prompt?.trim();
        if (!prompt) {
          return error(400, "prompt is required");
        }

        void service.prompt(sessionId, prompt).catch((err: unknown) => {
          console.error("prompt failed", err);
        });

        return json({ accepted: true }, 202);
      }

      const cancelMatch = path.match(/^\/v1\/sessions\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const sessionId = decodeURIComponent(cancelMatch[1] ?? "");
        const session = service.getSession(sessionId);
        if (!session) {
          return error(404, `Unknown session: ${sessionId}`);
        }

        service.cancel(sessionId);
        return json({ cancelled: true });
      }

      const streamMatch = path.match(/^\/v1\/sessions\/([^/]+)\/stream$/);
      if (request.method === "GET" && streamMatch) {
        const sessionId = decodeURIComponent(streamMatch[1] ?? "");
        const eventLog = service.getSessionEvents(sessionId);
        if (!eventLog) {
          return error(404, `Unknown session: ${sessionId}`);
        }

        const queryAfterSeq = url.searchParams.get("after_seq");
        const headerAfterSeq = request.headers.get("Last-Event-ID");
        const afterSeq = Number(queryAfterSeq ?? headerAfterSeq ?? "-1");

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("retry: 1000\n\n"));

              for (const event of eventLog.after(Number.isFinite(afterSeq) ? afterSeq : -1)) {
                controller.enqueue(encoder.encode(formatSseEvent(event)));
              }

              const unsubscribe = eventLog.subscribe((event) => {
                try {
                  controller.enqueue(encoder.encode(formatSseEvent(event)));
                } catch {
                  unsubscribe();
                }
              });

              const keepAlive = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode(": keepalive\n\n"));
                } catch {
                  clearInterval(keepAlive);
                  unsubscribe();
                }
              }, options.sseKeepAliveMs);

              const cleanup = () => {
                clearInterval(keepAlive);
                unsubscribe();
              };

              request.signal.addEventListener("abort", cleanup, { once: true });
            },
            cancel() {},
          }),
          {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            },
          },
        );
      }

      return error(404, "Not found");
    },
  });

  console.log(`${getBuildLabel()} server listening on http://localhost:${options.port}`);
  return server;
}

function formatSseEvent(event: FrontendEventEnvelope): string {
  const envelope = JSON.stringify(event);
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${envelope}\n\n`;
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {} as T;
  }

  return request.json() as Promise<T>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

if (import.meta.main) {
  await runHttpServerCommand(Bun.argv.slice(2));
}
