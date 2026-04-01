import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

function spawnCli(): {
  process: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
} {
  const child = spawn("bun", ["run", "nanoboss.ts", "cli"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NANO_AGENTBOSS_AGENT_CMD: "bun",
      NANO_AGENTBOSS_AGENT_ARGS: JSON.stringify(["run", "tests/fixtures/mock-agent.ts"]),
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

test("/quit exits the local CLI and prints the session id", async () => {
  const cli = spawnCli();

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
  const cli = spawnCli();

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
  const cli = spawnCli();

  try {
    await waitForContains(cli.stdout, "> ");
    cli.process.stdin.write("markdown demo\n");
    await waitForContains(cli.stdout, "const x = 1");

    const stdout = cli.stdout();
    expect(stdout).toContain("Demo");
    expect(stdout).toContain("- one");
    expect(stdout).toContain("const x = 1");
    expect(stdout).not.toContain("# Demo");
    expect(stdout).not.toContain("```ts");
    expect(stdout).not.toContain("```");
  } finally {
    if (cli.process.exitCode === null) {
      cli.process.kill();
      await once(cli.process, "exit");
    }
  }
}, 20_000);
