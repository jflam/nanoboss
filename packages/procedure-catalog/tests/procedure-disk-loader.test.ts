import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProcedureFromPath, persistProcedureSource } from "@nanoboss/procedure-catalog";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const tempDirs: string[] = [];

let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "nab-test-home-"));
  tempDirs.push(process.env.HOME);
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("procedure disk loader", () => {
  test("loads typia-based procedures through the runtime build pipeline", async () => {
    const procedure = await loadProcedureFromPath(join(REPO_ROOT, "procedures", "second-opinion.ts"));

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

  test("surfaces missing package diagnostics instead of a generic bundle failure", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nab-workspace-missing-package-"));
    const proceduresDir = join(workspaceRoot, ".nanoboss", "procedures");
    mkdirSync(proceduresDir, { recursive: true });
    writeFileSync(
      join(proceduresDir, "missing-package.ts"),
      [
        'import missing from "definitely-missing-package";',
        "",
        "export default {",
        '  name: "missing-package",',
        '  description: "broken procedure",',
        "  async execute() {",
        "    return missing;",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      await loadProcedureFromPath(join(proceduresDir, "missing-package.ts"));
      throw new Error("expected missing-package procedure load to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Could not resolve: "definitely-missing-package"');
      expect(message).toContain("specifier: definitely-missing-package");
      expect(message).not.toBe("Bundle failed");
    }
  });

  test("loads repo-local procedures that import internal workspace packages without a workspace node_modules", async () => {
    const previousHome = process.env.HOME;
    const runtimeHome = mkdtempSync(join(tmpdir(), "nab-runtime-home-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nab-workspace-internal-packages-"));
    const proceduresDir = join(workspaceRoot, ".nanoboss", "procedures");
    process.env.HOME = runtimeHome;

    try {
      mkdirSync(proceduresDir, { recursive: true });
      writeFileSync(
        join(proceduresDir, "workspace-alias.ts"),
        [
          'import { createRef } from "@nanoboss/contracts";',
          "",
          "export default {",
          '  name: "workspace-alias",',
          '  description: "workspace alias procedure",',
          "  async execute() {",
          '    return createRef({ sessionId: "session", runId: "run" }, "answer");',
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const procedure = await loadProcedureFromPath(join(proceduresDir, "workspace-alias.ts"));
      const result = await procedure.execute("", {} as never) as unknown;

      expect(procedure.name).toBe("workspace-alias");
      expect(result).toEqual({
        run: { sessionId: "session", runId: "run" },
        path: "answer",
      });
      expect(existsSync(join(workspaceRoot, "node_modules"))).toBe(false);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  test("loads typia-based procedures for a workspace without its own node_modules", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nab-workspace-no-modules-"));
    const proceduresDir = join(workspaceRoot, "procedures");
    mkdirSync(proceduresDir, { recursive: true });
    symlinkSync(join(REPO_ROOT, "src"), join(workspaceRoot, "src"), "dir");
    writeFileSync(join(workspaceRoot, "tsconfig.json"), readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8"), "utf8");
    writeFileSync(
      join(proceduresDir, "second-opinion.ts"),
      readFileSync(join(REPO_ROOT, "procedures", "second-opinion.ts"), "utf8"),
      "utf8",
    );

    const procedure = await loadProcedureFromPath(join(proceduresDir, "second-opinion.ts"));

    expect(procedure.name).toBe("second-opinion");
    expect(existsSync(join(workspaceRoot, "node_modules"))).toBe(false);
  });

  test("overlays runtime packages into an existing workspace node_modules", async () => {
    const previousHome = process.env.HOME;
    const runtimeHome = mkdtempSync(join(tmpdir(), "nab-runtime-home-"));
    process.env.HOME = runtimeHome;

    try {
      const runtimeNodeModulesDir = join(runtimeHome, ".nanoboss", "runtime", "node_modules", "@nanoboss", "runtime-only");
      mkdirSync(runtimeNodeModulesDir, { recursive: true });
      writeFileSync(
        join(runtimeNodeModulesDir, "package.json"),
        JSON.stringify({
          name: "@nanoboss/runtime-only",
          type: "module",
          exports: "./index.ts",
        }),
        "utf8",
      );
      writeFileSync(
        join(runtimeNodeModulesDir, "index.ts"),
        "export function describeProcedure(): string { return \"runtime-only procedure\"; }\n",
        "utf8",
      );

      const workspaceRoot = mkdtempSync(join(tmpdir(), "nab-workspace-runtime-overlay-"));
      const proceduresDir = join(workspaceRoot, ".nanoboss", "procedures");
      mkdirSync(join(workspaceRoot, "node_modules"), { recursive: true });
      mkdirSync(proceduresDir, { recursive: true });
      writeFileSync(
        join(proceduresDir, "runtime-overlay.ts"),
        [
          "import { describeProcedure } from \"@nanoboss/runtime-only\";",
          "",
          "export default {",
          "  name: \"runtime-overlay\",",
          "  description: describeProcedure(),",
          "  async execute() {",
          "    return {};",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const procedure = await loadProcedureFromPath(join(proceduresDir, "runtime-overlay.ts"));

      expect(procedure.name).toBe("runtime-overlay");
      expect(procedure.description).toBe("runtime-only procedure");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  test("procedure-catalog declares the runtime build dependencies used by its typia plugin", () => {
    const packageJson = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", "procedure-catalog", "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.["@typia/transform"]).toBeDefined();
    expect(packageJson.dependencies?.typescript).toBeDefined();
  });

  test("persists generated procedures into an explicit procedure root", async () => {
    const procedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));

    const filePath = persistProcedureSource({
      procedureName: "generated-profile",
      source: "export default { name: \"generated-profile\", description: \"generated\", async execute() { return {}; } };",
      procedureRoot,
    });

    expect(filePath).toBe(join(procedureRoot, "generated-profile.ts"));
    expect(existsSync(filePath)).toBe(true);
  });

  test("persists scoped generated procedures into package directories", async () => {
    const procedureRoot = mkdtempSync(join(tmpdir(), "nab-profile-procedures-"));

    const filePath = persistProcedureSource({
      procedureName: "kb/answer",
      source: "export default { name: \"kb/answer\", description: \"generated\", async execute() { return {}; } };",
      procedureRoot,
    });

    expect(filePath).toBe(join(procedureRoot, "kb", "answer.ts"));
    expect(existsSync(filePath)).toBe(true);
  });
});
