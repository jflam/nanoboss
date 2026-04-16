import { describe, expect, test } from "bun:test";

import { getWorkspaceIdentity } from "@nanoboss/app-support";
import { describeWorkspaceMismatch, matchesServerBuild } from "@nanoboss/adapters-http";

describe("http server supervisor", () => {
  test("treats dirty and clean builds as different", () => {
    expect(matchesServerBuild({
      status: "ok",
      buildCommit: "516daef",
    }, "516daef-dirty")).toBe(false);
  });

  test("accepts an exact build commit match", () => {
    expect(matchesServerBuild({
      status: "ok",
      buildCommit: "516daef-dirty",
    }, "516daef-dirty")).toBe(true);
  });

  test("rejects workspace mismatches for explicit shared servers", () => {
    expect(describeWorkspaceMismatch({
      status: "ok",
      workspaceKey: "/repo-two",
      repoRoot: "/repo-two",
      proceduresFingerprint: "def456",
    }, {
      ...getWorkspaceIdentity("/repo-one"),
      cwd: "/repo-one",
      repoRoot: "/repo-one",
      workspaceKey: "/repo-one",
      proceduresFingerprint: "abc123",
    })).toContain("/repo-two");
  });
});
