import { describe, expect, test } from "bun:test";

import {
  evaluateBuildFreshness,
  isBuildRelevantRepoPath,
  parseGitStatusPaths,
} from "../src/run/build-freshness-rules.ts";

describe("tui build freshness rules", () => {
  test("detects commit mismatch between working tree and installed CLI", () => {
    const status = evaluateBuildFreshness(
      {
        commit: "abcdef1",
        dirtyPaths: [],
      },
      {
        commit: "1234567",
        dirty: false,
      },
    );

    expect(status.outOfDate).toBe(true);
    expect(status.reason).toContain("working tree is at abcdef1");
  });

  test("detects clean build against dirty build-relevant working tree", () => {
    const status = evaluateBuildFreshness(
      {
        commit: "abcdef1",
        dirtyPaths: ["cli.ts", "packages/adapters-tui/src/app.ts"],
      },
      {
        commit: "abcdef1",
        dirty: false,
      },
    );

    expect(status.outOfDate).toBe(true);
    expect(status.reason).toContain("cli.ts, packages/adapters-tui/src/app.ts");
  });

  test("detects dirty files newer than a dirty installed binary", () => {
    const status = evaluateBuildFreshness(
      {
        commit: "abcdef1",
        dirtyPaths: ["packages/adapters-tui/src/app.ts"],
        newestDirtyMtimeMs: 2_000,
      },
      {
        commit: "abcdef1-dirty",
        dirty: true,
        mtimeMs: 500,
      },
    );

    expect(status.outOfDate).toBe(true);
    expect(status.reason).toContain("newer changes in packages/adapters-tui/src/app.ts");
  });

  test("accepts a matching dirty build when files are not newer than the executable", () => {
    const status = evaluateBuildFreshness(
      {
        commit: "abcdef1",
        dirtyPaths: ["packages/adapters-tui/src/app.ts"],
        newestDirtyMtimeMs: 1_000,
      },
      {
        commit: "abcdef1-dirty",
        dirty: true,
        mtimeMs: 1_500,
      },
    );

    expect(status).toEqual({ outOfDate: false });
  });

  test("parses git status paths and filters build-relevant files", () => {
    const paths = parseGitStatusPaths([
      " M cli.ts",
      "?? plans/2026-04-02-note.md",
      "R  packages/adapters-tui/src/old.ts -> packages/adapters-tui/src/new.ts",
    ].join("\n"));

    expect(paths).toEqual([
      "cli.ts",
      "plans/2026-04-02-note.md",
      "packages/adapters-tui/src/new.ts",
    ]);
    expect(paths.filter(isBuildRelevantRepoPath)).toEqual([
      "cli.ts",
      "packages/adapters-tui/src/new.ts",
    ]);
  });
});
