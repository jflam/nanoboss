import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureFile, writeJsonFileAtomic, writeTextFileAtomicSync } from "../../procedures/lib/repo-artifacts.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("repo-artifacts", () => {
  test("writeJsonFileAtomic creates parent directories and writes pretty JSON with a trailing newline", async () => {
    const cwd = createTempDir();
    const path = join(cwd, ".nanoboss", "artifacts", "state.json");

    await writeJsonFileAtomic(path, { enabled: true, count: 2 });

    expect(readFileSync(path, "utf8")).toBe('{\n  "enabled": true,\n  "count": 2\n}\n');
  });

  test("ensureFile seeds missing files but preserves existing contents", async () => {
    const cwd = createTempDir();
    const path = join(cwd, ".kb", "manifests", "sources.json");

    await ensureFile(path, "[]\n");
    writeFileSync(path, '[{"sourceId":"kept"}]\n', "utf8");

    await ensureFile(path, "[]\n");

    expect(readFileSync(path, "utf8")).toBe('[{"sourceId":"kept"}]\n');
  });

  test("writeTextFileAtomicSync replaces contents without leaving temp files behind", () => {
    const cwd = createTempDir();
    const path = join(cwd, ".nanoboss", "autoresearch", "summary.md");

    writeTextFileAtomicSync(path, "first\n");
    writeTextFileAtomicSync(path, "second\n");

    expect(readFileSync(path, "utf8")).toBe("second\n");
    expect(readdirSync(join(cwd, ".nanoboss", "autoresearch"))).toEqual(["summary.md"]);
  });
});

function createTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "repo-artifacts-"));
  tempDirs.push(path);
  return path;
}
