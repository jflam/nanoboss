import { NanoAgentBossService } from "./service.ts";

const port = Number(Bun.env.NANO_AGENTBOSS_PORT ?? "3000");
const service = await NanoAgentBossService.create();
const encoder = new TextEncoder();

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/v1/health") {
      return json({ status: "ok" });
    }

    if (request.method === "POST" && path === "/v1/sessions") {
      const body = await readJson<{ cwd?: string }>(request);
      const session = service.createSession({
        cwd: body.cwd ?? process.cwd(),
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
            }, 15_000);

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

console.log(`nano-agentboss http server listening on http://localhost:${port}`);

function formatSseEvent(event: unknown): string {
  const envelope = JSON.stringify(event);
  const parsed = event as { seq: number; type: string };
  return `id: ${parsed.seq}\nevent: ${parsed.type}\ndata: ${envelope}\n\n`;
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
