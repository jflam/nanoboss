import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProcedureRegistry } from "../../src/procedure/registry.ts";

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

  test("toAvailableCommands returns ACP formatted command descriptors", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-procedures-")));
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
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-procedures-")));
    registry.loadBuiltins();

    expect(registry.get("default")).toBeDefined();
    expect(registry.get("autoresearch")).toBeDefined();
    expect(registry.get("autoresearch/start")).toBeDefined();
    expect(registry.get("autoresearch/continue")).toBeDefined();
    expect(registry.get("autoresearch/status")).toBeDefined();
    expect(registry.get("autoresearch/clear")).toBeDefined();
    expect(registry.get("autoresearch/finalize")).toBeDefined();
    expect(registry.get("model")).toBeDefined();
    expect(registry.get("kb/ingest")).toBeDefined();
    expect(registry.get("kb/compile-source")).toBeDefined();
    expect(registry.get("kb/compile-concepts")).toBeDefined();
    expect(registry.get("kb/link")).toBeDefined();
    expect(registry.get("kb/render")).toBeDefined();
    expect(registry.get("kb/health")).toBeDefined();
    expect(registry.get("kb/refresh")).toBeDefined();
    expect(registry.get("kb/answer")).toBeDefined();
    expect(registry.get("commit")).toBeUndefined();
    expect(registry.get("nanoboss/pre-commit-checks")).toBeDefined();
    expect(registry.get("nanoboss/commit")).toBeDefined();
    expect(registry.get("simplify2")).toBeDefined();
    expect(registry.get("top_level_runs")).toBeUndefined();
    expect(registry.get("cell_get")).toBeUndefined();
    expect(registry.get("ref_read")).toBeUndefined();
    expect(registry.toAvailableCommands().some((command) => command.name === "default")).toBe(false);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch/start")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch/continue")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch/status")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch/clear")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "autoresearch/finalize")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "model")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb/ingest")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb/compile-source")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb/compile-concepts")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb/link")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb/render")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb/health")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb/refresh")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "kb/answer")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "commit")).toBe(false);
    expect(registry.toAvailableCommands().some((command) => command.name === "nanoboss/pre-commit-checks")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "nanoboss/commit")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "simplify2")).toBe(true);
    expect(registry.toAvailableCommands().some((command) => command.name === "top_level_runs")).toBe(false);
    expect(registry.toAvailableCommands().some((command) => command.name === "cell_get")).toBe(false);
    expect(registry.toAvailableCommands().some((command) => command.name === "ref_read")).toBe(false);
  });
});
