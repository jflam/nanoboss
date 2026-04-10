import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeferredProcedureMetadata } from "../../src/core/types.ts";
import { CREATE_PROCEDURE_METADATA } from "../../src/procedure/create.ts";
import { ProcedureRegistry, projectProcedureMetadata, toAvailableCommand } from "../../src/procedure/registry.ts";

function describeLazyMetadata(
  procedure: ReturnType<ProcedureRegistry["get"]>,
): DeferredProcedureMetadata | undefined {
  if (!procedure) {
    return undefined;
  }

  return {
    name: procedure.name,
    description: procedure.description,
    inputHint: procedure.inputHint,
    executionMode: procedure.executionMode,
    supportsResume: typeof procedure.resume === "function",
  };
}

describe("ProcedureRegistry", () => {
  test("loads procedures from the procedure root", async () => {
    const procedureRoot = mkdtempSync(join(tmpdir(), "nab-procedures-"));
    writeFileSync(
      join(procedureRoot, "hello.ts"),
      [
        "export default {",
        '  name: "hello",',
        '  description: "hello world",',
        '  async execute() { return "hi"; },',
        "};",
      ].join("\n"),
      "utf8",
    );

    const registry = new ProcedureRegistry(procedureRoot);
    await registry.loadFromDisk();

    expect(registry.get("hello")?.description).toBe("hello world");
    await expect(registry.get("hello")?.execute("", {} as never)).resolves.toBe("hi");
  });

  test("loads packaged procedures from nested directories and ignores helpers", async () => {
    const procedureRoot = mkdtempSync(join(tmpdir(), "nab-packaged-procedures-"));
    const packageDir = join(procedureRoot, "autoresearch");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "hello.ts"),
      [
        "export default {",
        '  name: "packaged-hello",',
        '  description: "packaged hello world",',
        '  async execute() { return "packaged"; },',
        "};",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(packageDir, "helper.ts"),
      [
        "export function helper(): string {",
        '  return "helper";',
        "}",
      ].join("\n"),
      "utf8",
    );

    const registry = new ProcedureRegistry(procedureRoot);
    await registry.loadFromDisk();

    expect(registry.get("packaged-hello")?.description).toBe("packaged hello world");
    expect(registry.get("helper")).toBeUndefined();
    await expect(registry.get("packaged-hello")?.execute("", {} as never)).resolves.toBe("packaged");
  });

  test("loads procedures from both repo and profile procedure roots", async () => {
    const repoProcedureRoot = mkdtempSync(join(tmpdir(), "nab-repo-procedures-"));
    const profileProcedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));

    writeFileSync(
      join(repoProcedureRoot, "repo-only.ts"),
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
      join(profileProcedureRoot, "profile-only.ts"),
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
      localProcedureRoot: repoProcedureRoot,
      profileProcedureRoot,
      diskProcedureRoots: [repoProcedureRoot, profileProcedureRoot],
    });
    await registry.loadFromDisk();

    expect(registry.get("repo-only")?.description).toBe("repo command");
    expect(registry.get("profile-only")?.description).toBe("profile command");
  });

  test("defers disk procedure compilation until first execution", async () => {
    const procedureRoot = mkdtempSync(join(tmpdir(), "nab-lazy-procedures-"));
    writeFileSync(
      join(procedureRoot, "broken.ts"),
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

    const registry = new ProcedureRegistry(procedureRoot);
    await expect(registry.loadFromDisk()).resolves.toBeUndefined();

    expect(registry.get("broken")?.description).toBe("broken command");
    await expect(registry.get("broken")?.execute("", {} as never)).rejects.toThrow();
  });

  test("preserves continuation support for lazy disk procedures", async () => {
    const procedureRoot = mkdtempSync(join(tmpdir(), "nab-resumable-procedures-"));
    writeFileSync(
      join(procedureRoot, "pausable.ts"),
      [
        "export default {",
        '  name: "pausable",',
        '  description: "pausable command",',
        '  async execute() { return "started"; },',
        "  async resume(prompt, state) {",
        '    return `${prompt}:${state.note}`;',
        "  },",
        "};",
      ].join("\n"),
      "utf8",
    );

    const registry = new ProcedureRegistry(procedureRoot);
    await registry.loadFromDisk();

    const procedure = registry.get("pausable");
    expect(procedure?.resume).toBeDefined();
    await expect(procedure?.resume?.("again", { note: "saved" } as never, {} as never)).resolves.toBe("again:saved");
  });

  test("exposes the same lazy metadata surface for built-in and disk procedures", async () => {
    const procedureRoot = mkdtempSync(join(tmpdir(), "nab-descriptor-procedures-"));
    writeFileSync(
      join(procedureRoot, "guided.ts"),
      [
        "export default {",
        '  name: "guided",',
        '  description: "guided command",',
        '  inputHint: "what to do",',
        '  executionMode: "defaultConversation",',
        '  async execute() { return "guided"; },',
        "};",
      ].join("\n"),
      "utf8",
    );

    const registry = new ProcedureRegistry(procedureRoot);
    registry.loadBuiltins();
    await registry.loadFromDisk();

    const expectedMetadata = [
      {
        ...CREATE_PROCEDURE_METADATA,
        executionMode: undefined,
        supportsResume: false,
      },
      {
        name: "simplify",
        description: "Find and apply simplifications one opportunity at a time",
        inputHint: "Optional focus or scope",
        executionMode: "harness" as const,
        supportsResume: true,
      },
      {
        name: "guided",
        description: "guided command",
        inputHint: "what to do",
        executionMode: "defaultConversation" as const,
        supportsResume: false,
      },
    ];
    for (const expected of expectedMetadata) {
      expect(describeLazyMetadata(registry.get(expected.name))).toEqual(expected);
    }

    const expectedCommands = expectedMetadata.map(({
      supportsResume: _supportsResume,
      ...metadata
    }) => toAvailableCommand(metadata));
    const availableCommands = projectProcedureMetadata(registry.listMetadata()).map(toAvailableCommand);
    for (const expected of expectedCommands) {
      expect(availableCommands.find((command) => command.name === expected.name)).toEqual(expected);
    }

    await expect(registry.get("guided")?.execute("", {} as never)).resolves.toBe("guided");
    expect(describeLazyMetadata(registry.get("guided"))).toEqual(expectedMetadata[2]);
    expect(projectProcedureMetadata(registry.listMetadata()).find((procedure) => procedure.name === "guided")).toEqual({
      name: "guided",
      description: "guided command",
      inputHint: "what to do",
      executionMode: "defaultConversation",
    });
  });

  test("loads typia-based procedures through the runtime build pipeline", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-procedures-")));
    const procedure = await registry.loadProcedureFromPath(join(process.cwd(), "procedures", "second-opinion.ts"));

    expect(procedure.name).toBe("second-opinion");
    expect(procedure.description).toContain("Codex");
  });

  test("loads typia-based procedures for a workspace without its own node_modules", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nab-workspace-no-modules-"));
    const proceduresDir = join(workspaceRoot, "procedures");
    mkdirSync(proceduresDir, { recursive: true });
    symlinkSync(join(process.cwd(), "src"), join(workspaceRoot, "src"), "dir");
    writeFileSync(join(workspaceRoot, "tsconfig.json"), readFileSync(join(process.cwd(), "tsconfig.json"), "utf8"), "utf8");
    writeFileSync(
      join(proceduresDir, "second-opinion.ts"),
      readFileSync(join(process.cwd(), "procedures", "second-opinion.ts"), "utf8"),
      "utf8",
    );

    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-procedures-")));
    const procedure = await registry.loadProcedureFromPath(join(proceduresDir, "second-opinion.ts"));

    expect(procedure.name).toBe("second-opinion");
    expect(existsSync(join(workspaceRoot, "node_modules"))).toBe(false);
  });

  test("persists generated procedures into the profile procedure root outside the repo", async () => {
    const repoProcedureRoot = mkdtempSync(join(tmpdir(), "nab-repo-procedures-"));
    const profileProcedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "nab-workspace-"));
    const registry = new ProcedureRegistry({
      localProcedureRoot: repoProcedureRoot,
      profileProcedureRoot,
      diskProcedureRoots: [repoProcedureRoot, profileProcedureRoot],
    });

    const filePath = await registry.persist({
      name: "generated-profile",
      description: "generated",
      async execute() {
        return {};
      },
    }, "export default { name: \"generated-profile\", description: \"generated\", async execute() { return {}; } };", workspaceDir);

    expect(filePath).toBe(join(profileProcedureRoot, "generated-profile.ts"));
    expect(existsSync(filePath)).toBe(true);
  });

  test("persists generated procedures into the repo-local procedure root when running in a repo", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "nab-repo-root-"));
    const repoProcedureRoot = join(repoRoot, ".nanoboss", "procedures");
    const profileProcedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));
    mkdirSync(repoProcedureRoot, { recursive: true });
    writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
    writeFileSync(join(repoRoot, ".gitignore"), ".nanoboss/\n", "utf8");
    Bun.spawnSync(["git", "init"], { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
    const registry = new ProcedureRegistry({
      localProcedureRoot: repoProcedureRoot,
      profileProcedureRoot,
      diskProcedureRoots: [repoProcedureRoot, profileProcedureRoot],
    });

    const filePath = await registry.persist({
      name: "generated-repo",
      description: "generated",
      async execute() {
        return {};
      },
    }, "export default { name: \"generated-repo\", description: \"generated\", async execute() { return {}; } };", repoRoot);

    expect(filePath.endsWith("/.nanoboss/procedures/generated-repo.ts")).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain("generated-repo");
  });

  test("persists scoped generated procedures into package directories", async () => {
    const repoProcedureRoot = mkdtempSync(join(tmpdir(), "nab-repo-procedures-"));
    const profileProcedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "nab-workspace-"));
    const registry = new ProcedureRegistry({
      localProcedureRoot: repoProcedureRoot,
      profileProcedureRoot,
      diskProcedureRoots: [repoProcedureRoot, profileProcedureRoot],
    });

    const filePath = await registry.persist({
      name: "kb/answer",
      description: "generated",
      async execute() {
        return {};
      },
    }, "export default { name: \"kb/answer\", description: \"generated\", async execute() { return {}; } };", workspaceDir);

    expect(filePath).toBe(join(profileProcedureRoot, "kb", "answer.ts"));
    expect(existsSync(filePath)).toBe(true);
  });

  test("get returns undefined for unknown procedures", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-procedures-")));
    expect(registry.get("missing")).toBeUndefined();
  });

  test("register makes procedures available", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-procedures-")));
    registry.register({
      name: "double",
      description: "double a number",
      async execute(prompt) {
        return String(Number(prompt) * 2);
      },
    });

    expect(registry.get("double")).toBeDefined();
  });

  test("listMetadata remains canonical while discovery projection hides /default", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-procedures-")));
    registry.register({
      name: "default",
      description: "default command",
      async execute(prompt) {
        return prompt;
      },
    });
    registry.register({
      name: "double",
      description: "double a number",
      inputHint: "number",
      async execute(prompt) {
        return prompt;
      },
    });

    expect(registry.listMetadata()).toEqual([
      {
        name: "default",
        description: "default command",
        executionMode: undefined,
        inputHint: undefined,
      },
      {
        name: "double",
        description: "double a number",
        executionMode: undefined,
        inputHint: "number",
      },
    ]);
    expect(registry.listMetadata().find((procedure) => procedure.name === "default")).toEqual({
      name: "default",
      description: "default command",
      executionMode: undefined,
      inputHint: undefined,
    });
    expect(projectProcedureMetadata(registry.listMetadata()).map(toAvailableCommand)).toEqual([
      {
        name: "double",
        description: "double a number",
        input: { hint: "number" },
      },
    ]);
  });

  test("loadBuiltins keeps builtin pre-load metadata and slash command exposure aligned", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-procedures-")));
    registry.loadBuiltins();

    const defaultProcedure = registry.get("default");
    if (!defaultProcedure) {
      throw new Error("expected default builtin procedure to be registered");
    }
    const defaultMetadata = describeLazyMetadata(defaultProcedure);
    if (!defaultMetadata) {
      throw new Error("expected default builtin procedure metadata to be describable");
    }

    const expectedMetadata: [
      DeferredProcedureMetadata,
      DeferredProcedureMetadata,
      DeferredProcedureMetadata,
    ] = [
      defaultMetadata,
      {
        ...CREATE_PROCEDURE_METADATA,
        executionMode: undefined,
        supportsResume: false,
      },
      {
        name: "simplify",
        description: "Find and apply simplifications one opportunity at a time",
        inputHint: "Optional focus or scope",
        executionMode: "harness" as const,
        supportsResume: true,
      },
    ];
    for (const expected of expectedMetadata) {
      expect(describeLazyMetadata(registry.get(expected.name))).toEqual(expected);
    }

    expect(registry.get("nanoboss/commit")).toBeDefined();
    expect(registry.get("commit")).toBeUndefined();

    const commandsByName = new Map(projectProcedureMetadata(registry.listMetadata()).map((command) => [
      command.name,
      toAvailableCommand(command),
    ]));
    expect(commandsByName.has("default")).toBe(false);
    expect(commandsByName.get(CREATE_PROCEDURE_METADATA.name)).toEqual(toAvailableCommand(CREATE_PROCEDURE_METADATA));
    expect(commandsByName.get("simplify")).toEqual(toAvailableCommand(expectedMetadata[2]));
    expect(commandsByName.has("nanoboss/commit")).toBe(true);
    expect(commandsByName.has("commit")).toBe(false);
  });
});
