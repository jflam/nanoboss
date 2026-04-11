import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProcedureFromPath, persistProcedureSource } from "../../src/procedure/disk-loader.ts";

describe("procedure disk loader", () => {
  test("loads typia-based procedures through the runtime build pipeline", async () => {
    const procedure = await loadProcedureFromPath(join(process.cwd(), "procedures", "second-opinion.ts"));

    expect(procedure.name).toBe("second-opinion");
    expect(procedure.description).toContain("Codex");
  });

  test("loads local helper imports when they use explicit .ts paths", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nab-workspace-helpers-"));
    const proceduresDir = join(workspaceRoot, "procedures");
    mkdirSync(proceduresDir, { recursive: true });
    writeFileSync(
      join(proceduresDir, "helper.ts"),
      "export function describeProcedure(): string { return \"helper-backed procedure\"; }\n",
      "utf8",
    );
    writeFileSync(
      join(proceduresDir, "helper-procedure.ts"),
      [
        "import { describeProcedure } from \"./helper.ts\";",
        "",
        "export default {",
        "  name: \"helper-procedure\",",
        "  description: describeProcedure(),",
        "  async execute() {",
        "    return {};",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const procedure = await loadProcedureFromPath(join(proceduresDir, "helper-procedure.ts"));

    expect(procedure.description).toBe("helper-backed procedure");
  });

  test("rejects local helper imports without an explicit .ts extension", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nab-workspace-bad-helper-"));
    const proceduresDir = join(workspaceRoot, "procedures");
    mkdirSync(proceduresDir, { recursive: true });
    writeFileSync(
      join(proceduresDir, "helper.ts"),
      "export function describeProcedure(): string { return \"helper-backed procedure\"; }\n",
      "utf8",
    );
    writeFileSync(
      join(proceduresDir, "bad-helper-procedure.ts"),
      [
        "import { describeProcedure } from \"./helper\";",
        "",
        "export default {",
        "  name: \"bad-helper-procedure\",",
        "  description: describeProcedure(),",
        "  async execute() {",
        "    return {};",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadProcedureFromPath(join(proceduresDir, "bad-helper-procedure.ts"))).rejects.toThrow(
      "Procedure local imports must use explicit .ts paths: ./helper",
    );
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

    const procedure = await loadProcedureFromPath(join(proceduresDir, "second-opinion.ts"));

    expect(procedure.name).toBe("second-opinion");
    expect(existsSync(join(workspaceRoot, "node_modules"))).toBe(false);
  });

  test("persists generated procedures into the profile procedure root outside the repo", async () => {
    const profileProcedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "nab-workspace-"));

    const filePath = await persistProcedureSource({
      procedureName: "generated-profile",
      source: "export default { name: \"generated-profile\", description: \"generated\", async execute() { return {}; } };",
      cwd: workspaceDir,
      profileProcedureRoot,
    });

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

    const filePath = await persistProcedureSource({
      procedureName: "generated-repo",
      source: "export default { name: \"generated-repo\", description: \"generated\", async execute() { return {}; } };",
      cwd: repoRoot,
      profileProcedureRoot,
    });

    expect(filePath.endsWith("/.nanoboss/procedures/generated-repo.ts")).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain("generated-repo");
  });

  test("persists scoped generated procedures into package directories", async () => {
    const profileProcedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "nab-workspace-"));

    const filePath = await persistProcedureSource({
      procedureName: "kb/answer",
      source: "export default { name: \"kb/answer\", description: \"generated\", async execute() { return {}; } };",
      cwd: workspaceDir,
      profileProcedureRoot,
    });

    expect(filePath).toBe(join(profileProcedureRoot, "kb", "answer.ts"));
    expect(existsSync(filePath)).toBe(true);
  });
});
