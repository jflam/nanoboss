import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProcedureRegistry } from "../../src/registry.ts";

describe("ProcedureRegistry", () => {
  test("loads procedures from the commands directory", async () => {
    const commandsDir = mkdtempSync(join(tmpdir(), "nab-commands-"));
    writeFileSync(
      join(commandsDir, "hello.ts"),
      [
        "export default {",
        '  name: "hello",',
        '  description: "hello world",',
        '  async execute() { return "hi"; },',
        "};",
      ].join("\n"),
      "utf8",
    );

    const registry = new ProcedureRegistry(commandsDir);
    await registry.loadFromDisk();

    expect(registry.get("hello")?.description).toBe("hello world");
  });

  test("loads typia-based procedures through the runtime build pipeline", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-commands-")));
    const procedure = await registry.loadProcedureFromPath(join(process.cwd(), "commands", "second-opinion.ts"));

    expect(procedure.name).toBe("second-opinion");
    expect(procedure.description).toContain("Codex");
  });

  test("get returns undefined for unknown procedures", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-commands-")));
    expect(registry.get("missing")).toBeUndefined();
  });

  test("register makes procedures available", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-commands-")));
    registry.register({
      name: "double",
      description: "double a number",
      async execute(prompt) {
        return String(Number(prompt) * 2);
      },
    });

    expect(registry.get("double")).toBeDefined();
  });

  test("toAvailableCommands returns ACP formatted command descriptors", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-commands-")));
    registry.register({
      name: "double",
      description: "double a number",
      inputHint: "number",
      async execute(prompt) {
        return prompt;
      },
    });

    expect(registry.toAvailableCommands()).toEqual([
      {
        name: "double",
        description: "double a number",
        input: { hint: "number" },
      },
    ]);
  });

  test("loadBuiltins registers default but keeps it hidden from slash commands", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-commands-")));
    registry.loadBuiltins();

    expect(registry.get("default")).toBeDefined();
    expect(registry.get("model")).toBeDefined();
    expect(registry.toAvailableCommands().some((command) => command.name === "default")).toBe(false);
    expect(registry.toAvailableCommands().some((command) => command.name === "model")).toBe(true);
  });
});
