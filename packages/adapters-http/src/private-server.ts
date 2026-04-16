import { getBuildLabel } from "@nanoboss/app-support";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import { requestServerShutdown } from "./client.ts";
import { resolveSelfCommand } from "./self-command.ts";

const SERVER_START_TIMEOUT_MS = Number(process.env.NANOBOSS_SERVER_START_TIMEOUT_MS ?? "10000");
const SERVER_STOP_TIMEOUT_MS = Number(process.env.NANOBOSS_SERVER_STOP_TIMEOUT_MS ?? "5000");
const READY_PREFIX = "NANOBOSS_SERVER_READY ";
const MAX_CAPTURED_OUTPUT_CHARS = 16_000;

interface ServerReadyPayload {
  baseUrl: string;
  pid?: number;
  buildLabel?: string;
  mode?: string;
}

export interface StartedPrivateHttpServer {
  baseUrl: string;
  pid?: number;
  stop(): Promise<void>;
}

export async function startPrivateHttpServer(params: {
  cwd: string;
}): Promise<StartedPrivateHttpServer> {
  const command = resolveSelfCommand("http", [
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--mode",
    "private",
    "--ready-signal",
  ]);
  const child = spawn(command.command, command.args, {
    cwd: params.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let stdoutLineBuffer = "";
  let stopped = false;

  const ready = new Promise<ServerReadyPayload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(formatStartupError(
        `Timed out waiting for ${getBuildLabel()} private server startup`,
        stdout,
        stderr,
      )));
    }, SERVER_START_TIMEOUT_MS);

    const rejectWithOutput = (message: string): void => {
      clearTimeout(timeout);
      reject(new Error(formatStartupError(message, stdout, stderr)));
    };

    child.once("error", (error) => {
      rejectWithOutput(`Failed to spawn private nanoboss HTTP server: ${error.message}`);
    });

    child.once("exit", (code, signal) => {
      rejectWithOutput(
        `Private nanoboss HTTP server exited before readiness (code=${String(code)}, signal=${String(signal)})`,
      );
    });

    child.stdout.on("data", (chunk: string) => {
      stdout = appendCapturedOutput(stdout, chunk);
      stdoutLineBuffer += chunk;

      for (;;) {
        const lineBreak = stdoutLineBuffer.indexOf("\n");
        if (lineBreak < 0) {
          break;
        }

        const line = stdoutLineBuffer.slice(0, lineBreak).replace(/\r$/, "");
        stdoutLineBuffer = stdoutLineBuffer.slice(lineBreak + 1);
        if (!line.startsWith(READY_PREFIX)) {
          continue;
        }

        clearTimeout(timeout);
        try {
          const payload = JSON.parse(line.slice(READY_PREFIX.length)) as ServerReadyPayload;
          if (!payload.baseUrl) {
            throw new Error("missing baseUrl");
          }
          if (payload.mode !== "private") {
            throw new Error(`unexpected server mode: ${String(payload.mode)}`);
          }
          resolve(payload);
        } catch (error) {
          rejectWithOutput(
            `Private nanoboss HTTP server emitted an invalid readiness payload: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapturedOutput(stderr, chunk);
    });
  });

  const server = await ready;

  return {
    baseUrl: server.baseUrl,
    pid: server.pid,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;

      if (child.exitCode !== null) {
        return;
      }

      try {
        await requestServerShutdown(server.baseUrl);
      } catch {
        // Fall through to process termination below if shutdown is already unavailable.
      }

      if (await waitForExit(child, SERVER_STOP_TIMEOUT_MS)) {
        return;
      }

      child.kill("SIGTERM");
      if (await waitForExit(child, SERVER_STOP_TIMEOUT_MS)) {
        return;
      }

      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
}

function appendCapturedOutput(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_CAPTURED_OUTPUT_CHARS
    ? combined
    : combined.slice(combined.length - MAX_CAPTURED_OUTPUT_CHARS);
}

function formatStartupError(message: string, stdout: string, stderr: string): string {
  const output = [
    stdout.trim() ? `stdout:\n${stdout.trimEnd()}` : undefined,
    stderr.trim() ? `stderr:\n${stderr.trimEnd()}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return output.length > 0
    ? `${message}\n\n${output.join("\n\n")}`
    : message;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const handleExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
    };

    child.on("exit", handleExit);
  });
}
