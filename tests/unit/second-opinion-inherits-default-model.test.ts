import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { DownstreamAgentConfig } from "@nanoboss/contracts";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import { CommandContextImpl, RunLogger } from "@nanoboss/procedure-engine";
import { SessionStore } from "@nanoboss/store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("/second-opinion", () => {
  test("inherits the current default model for the first pass", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nab-second-opinion-"));
    tempDirs.push(tempDir);

    const logPath = join(tempDir, "agent-log.jsonl");
    const agentScript = join(process.cwd(), "tests/fixtures/model-aware-mock-agent.ts");
    const firstPassCommand = join(tempDir, "current-default-acp");
    const codexCommand = join(tempDir, "codex-acp");

    writeExecutable(
      firstPassCommand,
      buildWrapperScript({
        agentId: "first-pass",
        logPath,
        targetScript: agentScript,
      }),
    );
    writeExecutable(
      codexCommand,
      buildWrapperScript({
        agentId: "codex",
        logPath,
        targetScript: agentScript,
      }),
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;

    try {
      const registry = new ProcedureRegistry();
      registry.loadBuiltins();
      const procedure = registry.get("second-opinion");
      if (!procedure) {
        throw new Error("Missing /second-opinion procedure");
      }

      const logger = new RunLogger();
      const store = new SessionStore({
        sessionId: crypto.randomUUID(),
        cwd: process.cwd(),
      });

      const defaultConfig: DownstreamAgentConfig = {
        provider: "gemini",
        command: firstPassCommand,
        args: [],
        cwd: process.cwd(),
        model: "gemini-2.5-flash",
      };

      const ctx = new CommandContextImpl({
        cwd: process.cwd(),
        logger,
        registry,
        procedureName: "second-opinion",
        spanId: logger.newSpan(),
        emitter: {
          emit() {},
          async flush() {},
        },
        store,
        run: store.startRun({
          procedure: "second-opinion",
          input: "Explain pagination bugs.",
          kind: "top_level",
        }),
        getDefaultAgentConfig: () => defaultConfig,
        setDefaultAgentSelection: () => defaultConfig,
      });

      const result = await procedure.execute("Explain pagination bugs.", ctx);
      if (!result || typeof result === "string") {
        throw new Error("Expected ProcedureResult object");
      }

      expect(result.display).toContain("First answer (gemini/gemini-2.5-flash)");
      expect(result.display).toContain("first-pass:gemini-2.5-flash");
      expect(result.display).toContain("Codex critique (gpt-5.4/high)");

      const logEntries = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(hasLogEntry(logEntries, {
        kind: "set_model",
        agentId: "first-pass",
        modelId: "gemini-2.5-flash",
      })).toBe(true);
      expect(hasLogEntry(logEntries, {
        kind: "prompt",
        agentId: "first-pass",
        modelId: "gemini-2.5-flash",
      })).toBe(true);
      expect(hasLogEntry(logEntries, {
        kind: "set_model",
        agentId: "codex",
        modelId: "gpt-5.4/high",
      })).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 30_000);
});

function hasLogEntry(
  entries: ReadonlyArray<Record<string, unknown>>,
  expected: Record<string, unknown>,
): boolean {
  return entries.some((entry) =>
    Object.entries(expected).every(([key, value]) => entry[key] === value)
  );
}

function buildWrapperScript(params: { agentId: string; logPath: string; targetScript: string }): string {
  return [
    "#!/bin/sh",
    `export MODEL_AWARE_AGENT_ID=${shellEscape(params.agentId)}`,
    `export MODEL_AWARE_AGENT_LOG=${shellEscape(params.logPath)}`,
    `exec bun run ${shellEscape(params.targetScript)}`,
    "",
  ].join("\n");
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
