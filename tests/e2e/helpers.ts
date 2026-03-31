import { describe } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

export const runRealAgentE2E =
  process.env.SKIP_E2E !== "1" && process.env.NANO_AGENTBOSS_RUN_E2E === "1";

export const describeE2E = runRealAgentE2E ? describe : describe.skip;

export interface SpawnedProcess {
  process: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  write(input: string): void;
  stop(): Promise<void>;
}

export async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve port");
  }

  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return port;
}

export function mockAgentEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    NANO_AGENTBOSS_AGENT_CMD: "bun",
    NANO_AGENTBOSS_AGENT_ARGS: JSON.stringify(["run", "tests/fixtures/mock-agent.ts"]),
    ...extra,
  } as Record<string, string>;
}

export function spawnNanoboss(args: string[], env: Record<string, string>): SpawnedProcess {
  const child = spawn("bun", ["run", "nanoboss.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    process: child,
    stdout: () => stdout,
    stderr: () => stderr,
    write(input: string) {
      child.stdin.write(input);
    },
    async stop() {
      if (child.exitCode !== null) {
        return;
      }

      child.kill();
      await once(child, "exit");
    },
  };
}

export async function waitForHealth(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const response = await fetch(new URL("/v1/health", baseUrl));
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for health at ${baseUrl}`);
    }

    await Bun.sleep(100);
  }
}

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*[A-Za-z]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "");
}

export async function waitForMatch(
  producer: () => string,
  matcher: RegExp | string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const current = producer();
    if (typeof matcher === "string" ? current.includes(matcher) : matcher.test(current)) {
      return current;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for match ${String(matcher)} in output:\n${current}`);
    }

    await Bun.sleep(50);
  }
}
