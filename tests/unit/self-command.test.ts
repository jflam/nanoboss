import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSelfCommandWithRuntime } from "../../src/self-command.ts";

describe("resolveSelfCommandWithRuntime", () => {
  test("uses the source entrypoint when running from a real script on disk", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nab-self-cmd-"));
    const scriptPath = join(tempDir, "some-test-runner.ts");
    writeFileSync(scriptPath, "export {};\n", "utf8");

    const command = resolveSelfCommandWithRuntime("server", ["--port", "6502"], {
      executable: "/usr/local/bin/bun",
      scriptPath,
    });

    expect(command.command).toBe("/usr/local/bin/bun");
    expect(command.args[0]?.endsWith("nanoboss.ts")).toBe(true);
    expect(command.args.slice(1)).toEqual(["server", "--port", "6502"]);
  });

  test("uses the compiled executable directly for bunfs virtual scripts", () => {
    const command = resolveSelfCommandWithRuntime("server", ["--port", "6502"], {
      executable: "/Users/jflam/.local/bin/nanoboss",
      scriptPath: "/$bunfs/root/nanoboss.js",
    });

    expect(command).toEqual({
      command: "/Users/jflam/.local/bin/nanoboss",
      args: ["server", "--port", "6502"],
    });
  });

  test("uses the source entrypoint when running under bun without a real script path", () => {
    const command = resolveSelfCommandWithRuntime("session-mcp", ["--session-id", "abc"], {
      executable: "/Users/jflam/.bun/bin/bun",
      scriptPath: undefined,
    });

    expect(command.command).toBe("/Users/jflam/.bun/bin/bun");
    expect(command.args[0]?.endsWith("nanoboss.ts")).toBe(true);
    expect(command.args.slice(1)).toEqual(["session-mcp", "--session-id", "abc"]);
  });
});
