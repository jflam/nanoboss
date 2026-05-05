import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT_OWNED_TESTS = [
  "app-support-helper-convergence.test.ts",
  "argv.test.ts",
  "autoresearch-command.test.ts",
  "build-freshness.test.ts",
  "build-size-report.test.ts",
  "cli-options.test.ts",
  "compact-test.test.ts",
  "context-call-agent-session.test.ts",
  "create-procedure.test.ts",
  "default-history.test.ts",
  "delete-remaining-src-core.test.ts",
  "doctor.test.ts",
  "execute-plan.test.ts",
  "frontend-events.test.ts",
  "http-server-options.test.ts",
  "knowledge-base-commands.test.ts",
  "linter.test.ts",
  "mcp-server.test.ts",
  "model-command.test.ts",
  "nanoboss.test.ts",
  "package-dependency-direction.test.ts",
  "package-helper-ownership.test.ts",
  "pre-commit-checks.test.ts",
  "procedure-dispatch-jobs.test.ts",
  "procedure-engine-helper-convergence.test.ts",
  "prompt-input.test.ts",
  "public-package-entrypoints.test.ts",
  "repo-helper-convergence.test.ts",
  "research-command.test.ts",
  "resume-options.test.ts",
  "resume.test.ts",
  "root-owned-core-relocation.test.ts",
  "root-test-boundary.test.ts",
  "service.test.ts",
  "simplify-command.test.ts",
  "simplify2-command.test.ts",
  "store-helper-convergence.test.ts",
  "test-home-isolation.test.ts",
  "tui-helper-convergence.test.ts",
  "ui-cli.test.ts",
] as const;

test("root unit tests stay within the approved cleanup boundary", () => {
  const actual = readdirSync(join(process.cwd(), "tests", "unit"))
    .filter((entry) => entry.endsWith(".test.ts"))
    .sort();
  const expected = [...ROOT_OWNED_TESTS].sort();

  expect(actual).toEqual(expected);
});
