import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getBuildCommit } from "@nanoboss/app-support";
import { ensureMatchingHttpServer, startPrivateHttpServer } from "@nanoboss/adapters-http";

describe("http server supervisor", () => {
  test("rejects a reachable server with a different build commit", async () => {
    const server = startHealthServer({
      status: "ok",
      buildCommit: "not-this-build",
      buildLabel: "not-this-build",
    });
    try {
      await expect(ensureMatchingHttpServer(server.url)).rejects.toThrow(/but this CLI/);
    } finally {
      server.stop();
    }
  });

  test("accepts an exact build commit match", async () => {
    const server = startHealthServer({
      status: "ok",
      buildCommit: getBuildCommit(),
    });
    try {
      await expect(ensureMatchingHttpServer(server.url)).resolves.toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("rejects workspace mismatches for explicit shared servers", async () => {
    const server = startHealthServer({
      status: "ok",
      buildCommit: getBuildCommit(),
      workspaceKey: "/repo-two",
      repoRoot: "/repo-two",
      proceduresFingerprint: "def456",
    });
    try {
      await expect(ensureMatchingHttpServer(server.url, { cwd: "/repo-one" })).rejects.toThrow(/repo-two/);
    } finally {
      server.stop();
    }
  });

  test("starts private servers through the shared self-command resolver", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nab-http-self-cmd-"));
    const commandPath = join(tempDir, "nanoboss-self-command");
    const argsPath = join(tempDir, "args.log");
    writeFileSync(commandPath, [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$NANOBOSS_TEST_HTTP_ARGS_LOG\"",
      "echo 'NANOBOSS_SERVER_READY {\"baseUrl\":\"http://127.0.0.1:1\",\"mode\":\"private\"}'",
      "",
    ].join("\n"), "utf8");
    chmodSync(commandPath, 0o755);

    const originalSelfCommand = process.env.NANOBOSS_SELF_COMMAND;
    const originalArgsLog = process.env.NANOBOSS_TEST_HTTP_ARGS_LOG;
    process.env.NANOBOSS_SELF_COMMAND = commandPath;
    process.env.NANOBOSS_TEST_HTTP_ARGS_LOG = argsPath;

    try {
      const server = await startPrivateHttpServer({ cwd: tempDir });
      await server.stop();

      expect(readFileSync(argsPath, "utf8").trim().split("\n")).toEqual([
        "http",
        "--host",
        "127.0.0.1",
        "--port",
        expect.stringMatching(/^\d+$/),
        "--mode",
        "private",
        "--ready-signal",
      ]);
    } finally {
      restoreEnv("NANOBOSS_SELF_COMMAND", originalSelfCommand);
      restoreEnv("NANOBOSS_TEST_HTTP_ARGS_LOG", originalArgsLog);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}

function startHealthServer(health: Record<string, unknown>): {
  url: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return Response.json(health);
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
