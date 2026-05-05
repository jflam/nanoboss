import { NanobossService } from "@nanoboss/app-runtime";
import {
  getBuildCommit,
  getBuildLabel,
  getWorkspaceIdentity,
} from "@nanoboss/app-support";
import {
  type DownstreamAgentSelection,
} from "@nanoboss/procedure-sdk";
import type { FrontendEventEnvelope } from "./event-mapping.ts";
import { parseSessionPromptRequestBody } from "./prompt-request.ts";
export interface HttpServerOptions {
  port: number;
  host?: string;
  mode: "private" | "shared";
  readySignal: boolean;
  idleTimeoutSeconds: number;
  sseKeepAliveMs: number;
}

export async function startHttpServer(options: HttpServerOptions): Promise<ReturnType<typeof Bun.serve>> {
  const service = await NanobossService.create();
  const encoder = new TextEncoder();
  const workspace = getWorkspaceIdentity(process.cwd());
  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    idleTimeout: options.idleTimeoutSeconds,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/v1/health") {
        return json({
          status: "ok",
          buildLabel: getBuildLabel(),
          buildCommit: getBuildCommit(),
          pid: process.pid,
          mode: options.mode,
          cwd: workspace.cwd,
          repoRoot: workspace.repoRoot,
          workspaceKey: workspace.workspaceKey,
          proceduresFingerprint: workspace.proceduresFingerprint,
        });
      }

      if (request.method === "POST" && path === "/v1/admin/shutdown") {
        queueServerShutdown(server);
        return json({ accepted: true });
      }

      if (request.method === "POST" && path === "/v1/sessions") {
        const body = await readJson<{
          cwd?: string;
          autoApprove?: boolean;
          defaultAgentSelection?: DownstreamAgentSelection;
        }>(request);
        const session = await service.createSessionReady({
          cwd: body.cwd ?? process.cwd(),
          autoApprove: body.autoApprove,
          defaultAgentSelection: body.defaultAgentSelection,
        });
        return json(session, 201);
      }

      if (request.method === "POST" && path === "/v1/sessions/resume") {
        const body = await readJson<{
          sessionId?: string;
          cwd?: string;
          autoApprove?: boolean;
          defaultAgentSelection?: DownstreamAgentSelection;
        }>(request);
        const sessionId = body.sessionId?.trim();
        if (!sessionId) {
          return error(400, "sessionId is required");
        }

        try {
          const session = await service.resumeSessionReady({
            sessionId,
            cwd: body.cwd ?? process.cwd(),
            autoApprove: body.autoApprove,
            defaultAgentSelection: body.defaultAgentSelection,
          });
          return json(session);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return error(404, message);
        }
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

      const autoApproveMatch = path.match(/^\/v1\/sessions\/([^/]+)\/auto-approve$/);
      if (request.method === "POST" && autoApproveMatch) {
        const sessionId = decodeURIComponent(autoApproveMatch[1] ?? "");
        const session = service.getSession(sessionId);
        if (!session) {
          return error(404, `Unknown session: ${sessionId}`);
        }

        const body = await readJson<{ enabled?: unknown }>(request);
        if (typeof body.enabled !== "boolean") {
          return error(400, "enabled is required");
        }

        return json(service.setSessionAutoApprove(sessionId, body.enabled));
      }

      const promptMatch = path.match(/^\/v1\/sessions\/([^/]+)\/prompts$/);
      if (request.method === "POST" && promptMatch) {
        const sessionId = decodeURIComponent(promptMatch[1] ?? "");
        const session = service.getSession(sessionId);
        if (!session) {
          return error(404, `Unknown session: ${sessionId}`);
        }

        const body = await readJson<{ prompt?: string; promptInput?: unknown }>(request);
        const parsedPrompt = parseSessionPromptRequestBody(body);
        if ("error" in parsedPrompt) {
          return error(400, parsedPrompt.error);
        }

        void service.promptSession(sessionId, parsedPrompt.prompt).catch((err: unknown) => {
          console.error("session prompt failed", err);
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

        const body = await readJson<{ runId?: string }>(request);
        const runId = body.runId?.trim();
        if (!runId) {
          return error(400, "runId is required");
        }

        service.cancel(sessionId, runId);
        return json({ cancelled: true });
      }

      const continuationCancelMatch = path.match(
        /^\/v1\/sessions\/([^/]+)\/continuation-cancel$/,
      );
      if (request.method === "POST" && continuationCancelMatch) {
        const sessionId = decodeURIComponent(continuationCancelMatch[1] ?? "");
        const session = service.getSession(sessionId);
        if (!session) {
          return error(404, `Unknown session: ${sessionId}`);
        }

        const cancelled = await service.requestContinuationCancel(sessionId);
        return json({ cancelled });
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

  const baseUrl = formatBaseUrl(options.host, server.port ?? options.port);
  if (options.readySignal) {
    console.log(`NANOBOSS_SERVER_READY ${JSON.stringify({
      baseUrl,
      pid: process.pid,
      buildLabel: getBuildLabel(),
      mode: options.mode,
    })}`);
  }
  console.log(`${getBuildLabel()} server listening on ${baseUrl}`);
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

function queueServerShutdown(server: ReturnType<typeof Bun.serve>): void {
  setTimeout(() => {
    try {
      void server.stop(true);
    } finally {
      process.exit(0);
    }
  }, 50);
}

function formatBaseUrl(host: string | undefined, port: number): string {
  const resolvedHost = host?.includes(":")
    ? `[${host}]`
    : (host ?? "localhost");
  return `http://${resolvedHost}:${port}`;
}
