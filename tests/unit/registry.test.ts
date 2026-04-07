import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProcedureRegistry } from "../../src/procedure/registry.ts";

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
    await expect(registry.get("hello")?.execute("", {} as never)).resolves.toBe("hi");
  });

  test("loads procedures from both repo and profile command directories", async () => {
    const repoCommandsDir = mkdtempSync(join(tmpdir(), "nab-repo-commands-"));
    const profileCommandsDir = mkdtempSync(join(tmpdir(), "nab-profile-commands-"));

    writeFileSync(
      join(repoCommandsDir, "repo-only.ts"),
      [
        "export default {",
        '  name: "repo-only",',
        '  description: "repo command",',
        '  async execute() { return "repo"; },',
        "};",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(profileCommandsDir, "profile-only.ts"),
      [
        "export default {",
        '  name: "profile-only",',
        '  description: "profile command",',
        '  async execute() { return "profile"; },',
        "};",
      ].join("\n"),
      "utf8",
    );

    const registry = new ProcedureRegistry({
      commandsDir: repoCommandsDir,
      profileCommandsDir,
      diskCommandDirs: [repoCommandsDir, profileCommandsDir],
    });
    await registry.loadFromDisk();

    expect(registry.get("repo-only")?.description).toBe("repo command");
    expect(registry.get("profile-only")?.description).toBe("profile command");
  });

  test("defers disk procedure compilation until first execution", async () => {
    const commandsDir = mkdtempSync(join(tmpdir(), "nab-lazy-commands-"));
    writeFileSync(
      join(commandsDir, "broken.ts"),
      [
        'import "./missing.ts";',
        "export default {",
        '  name: "broken",',
        '  description: "broken command",',
        '  async execute() { return "broken"; },',
        "};",
      ].join("\n"),
      "utf8",
    );

    const registry = new ProcedureRegistry(commandsDir);
    await expect(registry.loadFromDisk()).resolves.toBeUndefined();

    expect(registry.get("broken")?.description).toBe("broken command");
    await expect(registry.get("broken")?.execute("", {} as never)).rejects.toThrow();
  });

  test("loads typia-based procedures through the runtime build pipeline", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-commands-")));
    const procedure = await registry.loadProcedureFromPath(join(process.cwd(), "commands", "second-opinion.ts"));

    expect(procedure.name).toBe("second-opinion");
    expect(procedure.description).toContain("Codex");
  });

  test("loads typia-based procedures for a workspace without its own node_modules", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nab-workspace-no-modules-"));
    const commandsDir = join(workspaceRoot, "commands");
    mkdirSync(commandsDir, { recursive: true });
    symlinkSync(join(process.cwd(), "src"), join(workspaceRoot, "src"), "dir");
    writeFileSync(join(workspaceRoot, "tsconfig.json"), readFileSync(join(process.cwd(), "tsconfig.json"), "utf8"), "utf8");
    writeFileSync(
      join(commandsDir, "second-opinion.ts"),
      readFileSync(join(process.cwd(), "commands", "second-opinion.ts"), "utf8"),
      "utf8",
    );

    const registry = new ProcedureRegistry(commandsDir);
    const procedure = await registry.loadProcedureFromPath(join(commandsDir, "second-opinion.ts"));

    expect(procedure.name).toBe("second-opinion");
    expect(existsSync(join(workspaceRoot, "node_modules"))).toBe(false);
  });

  test("persists generated procedures into the profile commands directory outside the repo", async () => {
    const repoCommandsDir = mkdtempSync(join(tmpdir(), "nab-repo-commands-"));
    const profileCommandsDir = mkdtempSync(join(tmpdir(), "nab-profile-commands-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "nab-workspace-"));
    const registry = new ProcedureRegistry({
      commandsDir: repoCommandsDir,
      profileCommandsDir,
      diskCommandDirs: [repoCommandsDir, profileCommandsDir],
    });

    const filePath = await registry.persist({
      name: "generated-profile",
      description: "generated",
      async execute() {
        return {};
      },
    }, "export default { name: \"generated-profile\", description: \"generated\", async execute() { return {}; } };", workspaceDir);

    expect(filePath).toBe(join(profileCommandsDir, "generated-profile.ts"));
    expect(existsSync(filePath)).toBe(true);
  });

  test("persists generated procedures into the repo commands directory when running in the nanoboss repo", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "nab-repo-root-"));
    const repoCommandsDir = join(repoRoot, "commands");
    const profileCommandsDir = mkdtempSync(join(tmpdir(), "nab-profile-commands-"));
    mkdirSync(repoCommandsDir, { recursive: true });
    writeFileSync(join(repoRoot, "nanoboss.ts"), "export {};\n", "utf8");
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "nanoboss", module: "nanoboss.ts" }), "utf8");
    const registry = new ProcedureRegistry({
      commandsDir: repoCommandsDir,
      profileCommandsDir,
      diskCommandDirs: [repoCommandsDir, profileCommandsDir],
    });

    const filePath = await registry.persist({
      name: "generated-repo",
      description: "generated",
      async execute() {
        return {};
      },
    }, "export default { name: \"generated-repo\", description: \"generated\", async execute() { return {}; } };", repoRoot);

    expect(filePath).toBe(join(repoCommandsDir, "generated-repo.ts"));
    expect(readFileSync(filePath, "utf8")).toContain("generated-repo");
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
    expect(registry.get("autoresearch")).toBeDefined();
    expect(registry.get("autoresearch-loop")).toBeDefined();
    expect(registry.get("autoresearch-stop")).toBeDefined();
    expect(registry.get("autoresearch-clear")).toBeDefined();
    expect(registry.get("autoresearch-finalize")).toBeDefined();
    expect(registry.get("model")).toBeDefined();
    expect(registry.get("kb-ingest")).toBeDefined();
    expect(registry.get("kb-compile-source")).toBeDefined();
    expect(registry.get("kb-compile-concepts")).toBeDefined();
    expect(registry.get("kb-link")).toBeDefined();
    expect(registry.get("kb-render")).toBeDefined();
    expect(registry.get("kb-health")).toBeDefined();
    expect(registry.get("kb-refresh")).toBeDefined();
    expect(registry.get("kb-answer")).toBeDefined();
    expect(registry.get("top_level_runs")).toBeDefined();
    expect(registry.get("cell_get")).toBeDefined();
    expect(registry.get("ref_read")).toBeDefined();
    expect(registry.toAvailableCommands().some((command) => command.name === "default")).toBe(false);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch-loop")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch-stop")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch-clear")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch-finalize")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "model")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb-ingest")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb-compile-source")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb-compile-concepts")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb-link")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb-render")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb-health")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb-refresh")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb-answer")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "top_level_runs")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "cell_get")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "ref_read")).toBe(true);
  });
});
