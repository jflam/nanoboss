import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeferredProcedureMetadata } from "../../src/core/types.ts";
import { CREATE_PROCEDURE_METADATA } from "../../src/procedure/create.ts";
import { ProcedureRegistry, projectProcedureMetadata, toAvailableCommand } from "../../src/procedure/registry.ts";

function describeProcedureMetadata(
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

function findListedProcedureMetadata(
  registry: ProcedureRegistry,
  name: string,
): ReturnType<ProcedureRegistry["listMetadata"]>[number] | undefined {
  return registry.listMetadata().find((procedure) => procedure.name === name);
}

function getRegisteredProcedure(
  registry: ProcedureRegistry,
  name: string,
): NonNullable<ReturnType<ProcedureRegistry["get"]>> {
  const procedure = registry.get(name);
  if (!procedure) {
    throw new Error(`expected ${name} procedure to be registered`);
  }

  return procedure;
}

function projectSingleProcedureMetadata(
  procedure: DeferredProcedureMetadata,
): ReturnType<ProcedureRegistry["listMetadata"]>[number] {
  const [metadata] = projectProcedureMetadata([procedure]);
  if (!metadata) {
    throw new Error(`expected ${procedure.name} metadata to be projectable`);
  }

  return metadata;
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

    const registry = new ProcedureRegistry({ procedureRoots: [procedureRoot] });
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

    const registry = new ProcedureRegistry({ procedureRoots: [procedureRoot] });
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
      procedureRoots: [repoProcedureRoot, profileProcedureRoot],
      profileProcedureRoot,
    });
    await registry.loadFromDisk();

    expect(registry.get("repo-only")?.description).toBe("repo command");
    expect(registry.get("profile-only")?.description).toBe("profile command");
  });

  test("persists generated procedures into the profile procedure root outside a repo", async () => {
    const profileProcedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "nab-workspace-"));
    const registry = new ProcedureRegistry({
      procedureRoots: [profileProcedureRoot],
      profileProcedureRoot,
    });

    const filePath = await registry.persist(
      "generated-profile",
      "export default { name: \"generated-profile\", description: \"generated\", async execute() { return {}; } };",
      workspaceDir,
    );

    expect(filePath).toBe(join(profileProcedureRoot, "generated-profile.ts"));
  });

  test("persists generated procedures into the repo-local procedure root inside a repo", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "nab-repo-root-"));
    const profileProcedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));
    Bun.spawnSync(["git", "init"], { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
    const registry = new ProcedureRegistry({
      procedureRoots: [profileProcedureRoot],
      profileProcedureRoot,
    });

    const filePath = await registry.persist(
      "generated-repo",
      "export default { name: \"generated-repo\", description: \"generated\", async execute() { return {}; } };",
      repoRoot,
    );

    expect(filePath.endsWith("/.nanoboss/procedures/generated-repo.ts")).toBe(true);
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

    const registry = new ProcedureRegistry({ procedureRoots: [procedureRoot] });
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

    const registry = new ProcedureRegistry({ procedureRoots: [procedureRoot] });
    await registry.loadFromDisk();

    const procedure = registry.get("pausable");
    expect(procedure?.resume).toBeDefined();
    await expect(procedure?.resume?.("again", { note: "saved" } as never, {} as never)).resolves.toBe("again:saved");
  });

  test("keeps the same metadata contract before and after realization for built-in and disk procedures", async () => {
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

    const registry = new ProcedureRegistry({ procedureRoots: [procedureRoot] });
    registry.loadBuiltins();
    await registry.loadFromDisk();

    const expectedMetadata = [
      {
        name: "model",
        description: "Set or inspect the default agent/model for this session",
        inputHint: "[agent] [model]",
        executionMode: "harness" as const,
        supportsResume: false,
      },
      {
        name: "guided",
        description: "guided command",
        inputHint: "what to do",
        executionMode: "defaultConversation" as const,
        supportsResume: false,
      },
    ] as const;

    const executions = new Map<string, () => Promise<unknown>>([
      [
        "model",
        async () =>
          await getRegisteredProcedure(registry, "model").execute("", {
            session: {
              getDefaultAgentConfig: () => ({ command: "codex", args: [], model: "gpt-5" }),
              setDefaultAgentSelection: () => ({ command: "codex", args: [], model: "gpt-5" }),
              getDefaultAgentTokenUsage: async () => undefined,
            },
          } as never),
      ],
      ["guided", async () => await getRegisteredProcedure(registry, "guided").execute("", {} as never)],
    ]);

    for (const expected of expectedMetadata) {
      const metadata = projectSingleProcedureMetadata(expected);
      expect(describeProcedureMetadata(getRegisteredProcedure(registry, expected.name))).toEqual(expected);
      expect(findListedProcedureMetadata(registry, expected.name)).toEqual(metadata);
      expect(projectProcedureMetadata(registry.listMetadata()).find((procedure) => procedure.name === expected.name))
        .toEqual(metadata);
      expect(
        projectProcedureMetadata(registry.listMetadata())
          .map(toAvailableCommand)
          .find((command) => command.name === expected.name),
      ).toEqual(toAvailableCommand(metadata));

      const execute = executions.get(expected.name);
      if (!execute) {
        throw new Error(`expected ${expected.name} execution to be registered`);
      }
      await expect(execute()).resolves.toBeDefined();

      expect(describeProcedureMetadata(getRegisteredProcedure(registry, expected.name))).toEqual(expected);
      expect(findListedProcedureMetadata(registry, expected.name)).toEqual(metadata);
    }

    expect(describeProcedureMetadata(registry.get(CREATE_PROCEDURE_METADATA.name))).toEqual({
      ...CREATE_PROCEDURE_METADATA,
      executionMode: undefined,
      supportsResume: false,
    });
  });

  test("listMetadata reflects loaded runtime fields after a lazy procedure is realized", async () => {
    const procedureRoot = mkdtempSync(join(tmpdir(), "nab-runtime-metadata-procedures-"));
    writeFileSync(
      join(procedureRoot, "runtime-shaped.ts"),
      [
        "export default {",
        '  name: "runtime-shaped",',
        '  description: "runtime metadata procedure",',
        '  get inputHint() { return "runtime only hint"; },',
        '  async execute() { return "runtime"; },',
        "};",
      ].join("\n"),
      "utf8",
    );

    const registry = new ProcedureRegistry({ procedureRoots: [procedureRoot] });
    await registry.loadFromDisk();

    expect(registry.get("runtime-shaped")?.inputHint).toBeUndefined();
    expect(registry.listMetadata().find((procedure) => procedure.name === "runtime-shaped")).toEqual({
      name: "runtime-shaped",
      description: "runtime metadata procedure",
      inputHint: undefined,
      executionMode: undefined,
      supportsResume: false,
    });

    await expect(registry.get("runtime-shaped")?.execute("", {} as never)).resolves.toBe("runtime");

    expect(registry.get("runtime-shaped")?.inputHint).toBe("runtime only hint");
    expect(registry.listMetadata().find((procedure) => procedure.name === "runtime-shaped")).toEqual({
      name: "runtime-shaped",
      description: "runtime metadata procedure",
      inputHint: "runtime only hint",
      executionMode: undefined,
      supportsResume: false,
    });
  });

  test("get returns undefined for unknown procedures", () => {
    const registry = new ProcedureRegistry({ procedureRoots: [mkdtempSync(join(tmpdir(), "nab-procedures-"))] });
    expect(registry.get("missing")).toBeUndefined();
  });

  test("register makes procedures available", () => {
    const registry = new ProcedureRegistry({ procedureRoots: [mkdtempSync(join(tmpdir(), "nab-procedures-"))] });
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
    const registry = new ProcedureRegistry({ procedureRoots: [mkdtempSync(join(tmpdir(), "nab-procedures-"))] });
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
        supportsResume: false,
      },
      {
        name: "double",
        description: "double a number",
        executionMode: undefined,
        inputHint: "number",
        supportsResume: false,
      },
    ]);
    expect(registry.listMetadata().find((procedure) => procedure.name === "default")).toEqual({
      name: "default",
      description: "default command",
      executionMode: undefined,
      inputHint: undefined,
      supportsResume: false,
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
    const registry = new ProcedureRegistry({ procedureRoots: [mkdtempSync(join(tmpdir(), "nab-procedures-"))] });
    registry.loadBuiltins();

    const defaultProcedure = registry.get("default");
    if (!defaultProcedure) {
      throw new Error("expected default builtin procedure to be registered");
    }
    const defaultMetadata = describeProcedureMetadata(defaultProcedure);
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
      expect(describeProcedureMetadata(registry.get(expected.name))).toEqual(expected);
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
