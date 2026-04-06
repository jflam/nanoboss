import { NanobossTuiApp, type NanobossTuiAppParams } from "./app.ts";
import type { FrontendConnectionMode } from "../options/frontend-connection.ts";
import { startPrivateHttpServer } from "../http/private-server.ts";

export function canUseNanobossTui(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export function assertInteractiveTty(commandName: string): void {
  if (canUseNanobossTui()) {
    return;
  }

  throw new Error(
    `nanoboss ${commandName} requires an interactive TTY; use the HTTP server, MCP, or ACP interfaces for automation.`,
  );
}

export interface RunTuiCliParams extends Omit<NanobossTuiAppParams, "serverUrl"> {
  connectionMode: FrontendConnectionMode;
  serverUrl?: string;
}

interface TuiAppRunner {
  run(): Promise<string | undefined>;
}

export interface RunTuiCliDeps {
  startPrivateHttpServer?: typeof startPrivateHttpServer;
  createApp?: (params: NanobossTuiAppParams) => TuiAppRunner;
}

export async function runTuiCli(params: RunTuiCliParams, deps: RunTuiCliDeps = {}): Promise<void> {
  let server: Awaited<ReturnType<typeof startPrivateHttpServer>> | undefined;

  try {
    server = params.connectionMode === "private"
      ? await (deps.startPrivateHttpServer ?? startPrivateHttpServer)({ cwd: params.cwd ?? process.cwd() })
      : undefined;
    const serverUrl = server?.baseUrl ?? params.serverUrl;
    if (!serverUrl) {
      throw new Error("nanoboss CLI expected a server URL or private server mode");
    }

    const app = (deps.createApp ?? ((appParams) => new NanobossTuiApp(appParams)))({
      cwd: params.cwd,
      serverUrl,
      showToolCalls: params.showToolCalls,
      sessionId: params.sessionId,
    });
    const sessionId = await app.run();
    if (sessionId) {
      process.stderr.write(`nanoboss session id: ${sessionId}\n`);
    }
  } finally {
    await server?.stop();
  }
}
