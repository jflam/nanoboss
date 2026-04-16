import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractFailureDetails,
  mergeCompactTestReports,
  parseJunitReport,
  renderCompactTestOutput,
} from "../../src/util/compact-test.ts";
import {
  computeCompactTestCommandFingerprint,
  findPassingCompactTestCacheEntry,
  loadCompactTestCache,
  upsertCompactTestCacheEntry,
  writeCompactTestCache,
} from "../../procedures/nanoboss/compact-test-cache.ts";

describe("compact test output", () => {
  test("parses pass skip and fail markers from junit xml", () => {
    const report = parseJunitReport([
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<testsuites tests=\"3\" failures=\"1\" skipped=\"1\" time=\"0.235974\">",
      "  <testsuite tests=\"3\" failures=\"1\" skipped=\"1\">",
      "    <testcase name=\"pass\" />",
      "    <testcase name=\"skip\">",
      "      <skipped />",
      "    </testcase>",
      "    <testcase name=\"fail\">",
      "      <failure type=\"AssertionError\" />",
      "    </testcase>",
      "  </testsuite>",
      "</testsuites>",
    ].join("\n"));

    expect(report).toEqual({
      statuses: [".", "S", "F"],
      total: 3,
      passed: 1,
      skipped: 1,
      failed: 1,
      timeSeconds: 0.235974,
    });
  });

  test("extracts only failure details from bun output", () => {
    const details = extractFailureDetails([
      "bun test v1.3.5 (1e86cebd)",
      "",
      "/tmp/sample.test.ts:",
      "1 | test(\"fail\", () => { expect(1).toBe(2); });",
      "                            ^",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 2",
      "Received: 1",
      "",
      "      at <anonymous> (/tmp/sample.test.ts:1:28)",
      "✗ fail [0.05ms]",
      "",
      " 1 pass",
      " 1 skip",
      " 1 fail",
      " 2 expect() calls",
      "Ran 3 tests across 1 file. [235.00ms]",
    ].join("\n"));

    expect(details).toContain("/tmp/sample.test.ts:");
    expect(details).toContain("✗ fail [0.05ms]");
    expect(details).not.toContain("bun test v1.3.5");
    expect(details).not.toContain("1 pass");
  });

  test("drops summary-only output when there are no failures", () => {
    const details = extractFailureDetails([
      "bun test v1.3.5 (1e86cebd)",
      "",
      "3 pass",
      "0 fail",
      "8 expect() calls",
      "Ran 3 tests across 1 file. [215.00ms]",
    ].join("\n"));

    expect(details).toBe("");
  });

  test("renders markers summary and failure details", () => {
    const rendered = renderCompactTestOutput({
      statuses: [".", "S", "F"],
      total: 3,
      passed: 1,
      skipped: 1,
      failed: 1,
      timeSeconds: 0.24,
    }, "failure details");

    expect(rendered).toContain(".SF");
    expect(rendered).toContain("1 pass, 1 skip, 1 fail, 3 total [0.24s]");
    expect(rendered).toContain("failure details");
  });

  test("merges multiple junit summaries and preserves wall time", () => {
    const merged = mergeCompactTestReports([
      {
        statuses: [".", "S"],
        total: 2,
        passed: 1,
        skipped: 1,
        failed: 0,
        timeSeconds: 1.5,
      },
      {
        statuses: [".", "F"],
        total: 2,
        passed: 1,
        skipped: 0,
        failed: 1,
        timeSeconds: 3.5,
      },
    ], 4.2);

    expect(merged).toEqual({
      statuses: [".", "S", ".", "F"],
      total: 4,
      passed: 2,
      skipped: 1,
      failed: 1,
      timeSeconds: 4.2,
    });
  });

  test("reuses a passing compact-test cache entry only on an exact key match", () => {
    const cwd = mkdtempSync(join(tmpdir(), "compact-test-cache-"));
    const cachePath = join(cwd, "test-clean.json");
    const commandFingerprint = computeCompactTestCommandFingerprint(["tests/unit/a.test.ts"]);
    writeCompactTestCache(cachePath, upsertCompactTestCacheEntry(loadCompactTestCache(cachePath), {
      repoFingerprint: "repo-a",
      commandFingerprint,
      runtimeFingerprint: "runtime-a",
      command: "bun test --only-failures tests/unit/a.test.ts",
      selectedTests: ["tests/unit/a.test.ts"],
      status: "passed",
      passedAt: "2026-04-09T00:00:00.000Z",
      report: {
        statuses: ["."],
        total: 1,
        passed: 1,
        skipped: 0,
        failed: 0,
        timeSeconds: 0.01,
      },
    }));

    const cache = loadCompactTestCache(cachePath);
    expect(findPassingCompactTestCacheEntry(cache, {
      repoFingerprint: "repo-a",
      commandFingerprint,
      runtimeFingerprint: "runtime-a",
    })?.command).toContain("tests/unit/a.test.ts");
    expect(findPassingCompactTestCacheEntry(cache, {
      repoFingerprint: "repo-b",
      commandFingerprint,
      runtimeFingerprint: "runtime-a",
    })).toBeUndefined();
  });
});
