import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import { reservePort } from "../e2e/helpers.ts";

let baseUrl = "";
let serverProcess: ReturnType<typeof spawn> | undefined;

function spawnCli(serverUrl: string): {
  process: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
} {
  const child = spawn("./dist/nanoboss", ["cli"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NANOBOSS_SERVER_URL: serverUrl,
      NANOBOSS_AGENT_CMD: "bun",
      NANOBOSS_AGENT_ARGS: JSON.stringify(["run", "tests/fixtures/mock-agent.ts"]),
    },
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
  };
}

async function waitForContains(producer: () => string, text: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (producer().includes(text)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${text} in output:\n${producer()}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForPromptCount(producer: () => string, expectedCount: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (countOccurrences(producer(), "> ") >= expectedCount) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for prompt count ${String(expectedCount)} in output:\n${producer()}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForServerHealth(serverUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(new URL("/v1/health", serverUrl));
      if (response.ok) {
        return;
      }
    } catch {
      // Keep waiting.
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for server health at ${serverUrl}`);
    }

    await Bun.sleep(50);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;

  for (;;) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

async function shutdownServer(serverUrl: string): Promise<void> {
  try {
    await fetch(new URL("/v1/admin/shutdown", serverUrl), { method: "POST" });
  } catch {
    // Ignore cleanup failures.
  }
}

beforeAll(async () => {
  const build = spawnSync("bun", ["run", "build"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (build.status !== 0) {
    throw new Error([
      "Failed to build dist/nanoboss for CLI integration tests.",
      build.stdout,
      build.stderr,
    ].filter(Boolean).join("\n"));
  }

  baseUrl = `http://localhost:${await reservePort()}`;
  const port = new URL(baseUrl).port;
  serverProcess = spawn("./dist/nanoboss", ["server", "--port", port], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NANOBOSS_AGENT_CMD: "bun",
      NANOBOSS_AGENT_ARGS: JSON.stringify(["run", "tests/fixtures/mock-agent.ts"]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForServerHealth(baseUrl);
}, 30_000);

afterAll(async () => {
  if (baseUrl) {
    await shutdownServer(baseUrl);
  }

  if (serverProcess?.exitCode === null) {
    await Promise.race([
      once(serverProcess, "exit"),
      Bun.sleep(1_000),
    ]);
  }

  if (serverProcess?.exitCode === null) {
    serverProcess.kill();
    await once(serverProcess, "exit");
  }
}, 10_000);

test("/quit exits the local CLI and prints the session id", async () => {
  const cli = spawnCli(baseUrl);

  try {
    await waitForContains(cli.stdout, "> ");
    cli.process.stdin.write("/quit\n");

    await Promise.race([
      once(cli.process, "exit"),
      Bun.sleep(10_000).then(() => {
        throw new Error("Timed out waiting for /quit to exit the CLI");
      }),
    ]);

    expect(cli.stderr()).toContain("nanoboss session id:");
  } finally {
    if (cli.process.exitCode === null) {
      cli.process.kill();
      await once(cli.process, "exit");
    }
  }
}, 20_000);

test("/exit is accepted as an exit alias", async () => {
  const cli = spawnCli(baseUrl);

  try {
    await waitForContains(cli.stdout, "> ");
    cli.process.stdin.write("/exit\n");

    await Promise.race([
      once(cli.process, "exit"),
      Bun.sleep(10_000).then(() => {
        throw new Error("Timed out waiting for /exit to exit the CLI");
      }),
    ]);

    expect(cli.stderr()).toContain("nanoboss session id:");
    expect(cli.stderr()).not.toContain("Unknown command: /exit");
  } finally {
    if (cli.process.exitCode === null) {
      cli.process.kill();
      await once(cli.process, "exit");
    }
  }
}, 20_000);

test("renders markdown agent output through the terminal markdown renderer", async () => {
  const cli = spawnCli(baseUrl);

  try {
    await waitForContains(cli.stdout, "> ");
    cli.process.stdin.write("markdown demo\n");
    await waitForContains(cli.stdout, "const x = 1");

    await waitForContains(cli.stderr, "[tokens] 512 / 8,192 (6.3%)");

    const stdout = cli.stdout();
    expect(stdout).toContain("Demo");
    expect(stdout).toContain("- one");
    expect(stdout).toContain("const x = 1");
    expect(stdout).not.toContain("# Demo");
    expect(stdout).not.toContain("```ts");
    expect(stdout).not.toContain("```");
    expect(cli.stderr()).toContain("[tokens] 512 / 8,192 (6.3%)");
  } finally {
    if (cli.process.exitCode === null) {
      cli.process.kill();
      await once(cli.process, "exit");
    }
  }
}, 20_000);

test("renders nested tool calls with rails under their parent wrapper", async () => {
  const cli = spawnCli(baseUrl);

  try {
    await waitForContains(cli.stdout, "> ");
    cli.process.stdin.write("nested tool trace demo\n");
    await waitForContains(cli.stderr, "[tool] defaultSession: nested tool trace demo");
    await waitForContains(cli.stderr, "│ [tool] Mock read README.md");

    expect(cli.stderr()).toContain("[tool] defaultSession: nested tool trace demo");
    expect(cli.stderr()).toContain("│ [tool] Mock read README.md");
  } finally {
    if (cli.process.exitCode === null) {
      cli.process.kill();
      await once(cli.process, "exit");
    }
  }
}, 20_000);

test("renders stored and injected memory cards around default turns", async () => {
  const cli = spawnCli(baseUrl);

  try {
    await waitForContains(cli.stdout, "> ");
    const initialPromptCount = countOccurrences(cli.stdout(), "> ");
    cli.process.stdin.write("/tokens\n");
    await waitForContains(cli.stdout, "No live token metrics yet.");
    await waitForContains(cli.stderr, "[memory] stored /tokens @ ");
    await waitForPromptCount(cli.stdout, initialPromptCount + 1);

    cli.process.stdin.write("what is 2+2\n");
    await waitForContains(cli.stderr, "[tool] defaultSession: what is 2+2");

    expect(cli.stderr()).toContain("[memory] stored /tokens @ ");
    expect(cli.stderr()).not.toContain("[memory] injecting 1 card");
  } finally {
    if (cli.process.exitCode === null) {
      cli.process.kill();
      await once(cli.process, "exit");
    }
  }
}, 20_000);

test("routes slash commands through procedure_dispatch in the master session", async () => {
  const cli = spawnCli(baseUrl);

  try {
    await waitForContains(cli.stdout, "> ");
    cli.process.stdin.write("/tokens\n");
    await waitForContains(cli.stdout, "No live token metrics yet.");
    await waitForContains(cli.stderr, "[tool] procedure_dispatch");

    expect(cli.stderr()).toContain("[tool] procedure_dispatch");
    expect(cli.stderr()).not.toContain("[memory] injecting 1 card");
  } finally {
    if (cli.process.exitCode === null) {
      cli.process.kill();
      await once(cli.process, "exit");
    }
  }
}, 20_000);
