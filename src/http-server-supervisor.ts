import { spawn } from "node:child_process";

import { getBuildCommit, getBuildLabel } from "./build-info.ts";
import { DEFAULT_HTTP_SERVER_PORT } from "./defaults.ts";
import { getServerHealth, requestServerShutdown, type ServerHealthResponse } from "./http-client.ts";
import { resolveSelfCommand } from "./self-command.ts";

const SERVER_START_TIMEOUT_MS = Number(process.env.NANOBOSS_SERVER_START_TIMEOUT_MS ?? "10000");
const SERVER_STOP_TIMEOUT_MS = Number(process.env.NANOBOSS_SERVER_STOP_TIMEOUT_MS ?? "5000");

export async function ensureMatchingHttpServer(
  baseUrl: string,
  options: {
    cwd?: string;
    onStatus?: (text: string) => void;
  } = {},
): Promise<void> {
  const desiredCommit = getBuildCommit();
  const desiredLabel = getBuildLabel();
  const initialHealth = await tryGetServerHealth(baseUrl);

  if (matchesServerBuild(initialHealth, desiredCommit)) {
    return;
  }

  const serverUrl = new URL(baseUrl);
  if (!isLoopbackServerUrl(serverUrl)) {
    if (!initialHealth) {
      throw new Error(`Failed to reach the nanoboss HTTP server at ${baseUrl}`);
    }

    throw new Error(
      `nanoboss HTTP server at ${baseUrl} is ${initialHealth.buildLabel ?? "unknown"}, but this CLI is ${desiredLabel}. Restart the remote server manually.`,
    );
  }

  if (initialHealth) {
    options.onStatus?.(`[server] restarting ${initialHealth.buildLabel ?? "nanoboss"} at ${baseUrl}`);
    await tryShutdownServer(baseUrl);
    let stopped = await waitForServerState(baseUrl, (health) => health === null, SERVER_STOP_TIMEOUT_MS);
    if (!stopped && initialHealth.pid) {
      tryKillServerProcess(initialHealth.pid);
      stopped = await waitForServerState(baseUrl, (health) => health === null, SERVER_STOP_TIMEOUT_MS);
    }
    if (!stopped) {
      throw new Error(`Timed out waiting for the existing nanoboss HTTP server at ${baseUrl} to stop`);
    }
  } else {
    options.onStatus?.(`[server] starting ${desiredLabel} at ${baseUrl}`);
  }

  spawnBackgroundServer(serverUrl, options.cwd ?? process.cwd());

  const ready = await waitForServerState(
    baseUrl,
    (health) => matchesServerBuild(health, desiredCommit),
    SERVER_START_TIMEOUT_MS,
  );
  if (!ready) {
    throw new Error(`Timed out waiting for nanoboss HTTP server ${desiredLabel} at ${baseUrl}`);
  }
}

function spawnBackgroundServer(serverUrl: URL, cwd: string): void {
  const port = resolveServerPort(serverUrl);
  const command = resolveSelfCommand("server", ["--port", String(port)]);
  const child = spawn(command.command, command.args, {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function tryGetServerHealth(baseUrl: string): Promise<ServerHealthResponse | null> {
  try {
    return await getServerHealth(baseUrl);
  } catch {
    return null;
  }
}

async function tryShutdownServer(baseUrl: string): Promise<void> {
  try {
    await requestServerShutdown(baseUrl);
  } catch {
    // Ignore shutdown failures and let the caller surface timeout if the server stays up.
  }
}

async function waitForServerState(
  baseUrl: string,
  predicate: (health: ServerHealthResponse | null) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const health = await tryGetServerHealth(baseUrl);
    if (predicate(health)) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await Bun.sleep(100);
  }
}

export function matchesServerBuild(
  health: ServerHealthResponse | null,
  desiredCommit: string,
): boolean {
  return health?.buildCommit === desiredCommit;
}

function isLoopbackServerUrl(url: URL): boolean {
  return url.protocol === "http:" && (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  );
}

function tryKillServerProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore kill failures and let startup timeout surface the problem.
  }
}

function resolveServerPort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }

  if (url.protocol === "https:") {
    return 443;
  }

  if (url.protocol === "http:") {
    return DEFAULT_HTTP_SERVER_PORT;
  }

  return DEFAULT_HTTP_SERVER_PORT;
}
