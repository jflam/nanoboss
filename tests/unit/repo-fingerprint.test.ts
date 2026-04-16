import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeRepoFingerprint } from "../../procedures/lib/repo-fingerprint.ts";

describe("repo fingerprint", () => {
  test("returns the same fingerprint for unchanged contents", () => {
    const cwd = createWorkspace();

    expect(computeRepoFingerprint({ cwd }).fingerprint).toBe(computeRepoFingerprint({ cwd }).fingerprint);
  });

  test("changes when relevant file contents change", () => {
    const cwd = createWorkspace();
    const before = computeRepoFingerprint({ cwd }).fingerprint;

    writeFileSync(join(cwd, "src", "app.ts"), "export const value = 2;\n", "utf8");

    expect(computeRepoFingerprint({ cwd }).fingerprint).not.toBe(before);
  });

  test("ignores excluded artifact directories", () => {
    const cwd = createWorkspace();
    const before = computeRepoFingerprint({ cwd }).fingerprint;

    mkdirSync(join(cwd, ".nanoboss"), { recursive: true });
    writeFileSync(join(cwd, ".nanoboss", "cache.json"), "{\"ok\":true}\n", "utf8");
    mkdirSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "dist", "bundle.js"), "console.log('ignored');\n", "utf8");

    expect(computeRepoFingerprint({ cwd }).fingerprint).toBe(before);
  });
});

function createWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "repo-fingerprint-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "app.ts"), "export const value = 1;\n", "utf8");
  writeFileSync(join(cwd, "package.json"), '{ "name": "fingerprint-fixture" }\n', "utf8");
  return cwd;
}
