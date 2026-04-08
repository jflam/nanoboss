import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import researchProcedure from "../../procedures/research.ts";
import type { CommandContext, DownstreamAgentConfig, RunResult } from "../../src/core/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) {
      throw new Error("Expected temporary directory path");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("/research", () => {
  test("always writes the cited report to the plans directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nab-research-"));
    tempDirs.push(cwd);

    const prints: string[] = [];
    const report = [
      "# Findings",
      "",
      "Pi TUI moved to a new renderer.[1]",
      "",
      "## Sources",
      "",
      "1. https://example.com/pi-tui",
    ].join("\n");
    const abstract = "Pi TUI changed how rendering works.";

    const result = await researchProcedure.execute(
      "summarize the pi-tui update",
      createMockContext({
        cwd,
        print: (text) => {
          prints.push(text);
        },
        agentResult: {
          report,
          abstract,
          descriptionWords: ["pi", "tui", "review"],
        },
      }),
    );

    const plansDir = join(cwd, "plans");
    const planFiles = readdirSync(plansDir);

    expect(planFiles).toHaveLength(1);

    const relativePath = `plans/${planFiles[0]}`;
    const absolutePath = join(cwd, relativePath);

    expect(existsSync(absolutePath)).toBe(true);
    expect(readFileSync(absolutePath, "utf8")).toBe(`${report}\n`);
    expect(result.data).toEqual({ report, abstract });
    expect(result.display).toBe(`${abstract}\n\nDetailed report written to ${relativePath}.\n`);
    expect(result.summary).toBe(`research: summarize the pi-tui update -> ${relativePath}`);
    expect(result.memory).toBe(
      `Research completed for summarize the pi-tui update. The cited report was also written to ${relativePath}.`,
    );
    expect(prints).toContain("Starting research...\n");
    expect(prints).toContain(`Wrote detailed report to ${relativePath}.\n`);
    expect(prints).toContain("Completed research.\n");
  });
});

function createMockContext(params: {
  cwd: string;
  print(text: string): void;
  agentResult: {
    report: string;
    abstract: string;
    descriptionWords: string[];
  };
}): CommandContext {
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "copilot",
    command: "bun",
    args: [],
    cwd: params.cwd,
  };

  const callAgent = async () => ({
    cell: {
      sessionId: "test-session",
      cellId: "test-cell",
    },
    data: params.agentResult,
  }) as RunResult<typeof params.agentResult>;

  return {
    cwd: params.cwd,
    sessionId: "test-session",
    refs: {
      async read() {
        throw new Error("Not implemented in test");
      },
      async stat() {
        throw new Error("Not implemented in test");
      },
      async writeToFile() {
        throw new Error("Not implemented in test");
      },
    },
    session: {
      async recent() {
        return [];
      },
      async topLevelRuns() {
        return [];
      },
      async get() {
        throw new Error("Not implemented in test");
      },
      async ancestors() {
        return [];
      },
      async descendants() {
        return [];
      },
    },
    assertNotCancelled() {},
    getDefaultAgentConfig() {
      return defaultAgentConfig;
    },
    setDefaultAgentSelection() {
      return defaultAgentConfig;
    },
    async getDefaultAgentTokenSnapshot() {
      return undefined;
    },
    async getDefaultAgentTokenUsage() {
      return undefined;
    },
    callAgent: callAgent as CommandContext["callAgent"],
    async callProcedure() {
      throw new Error("Not implemented in test");
    },
    async continueDefaultSession() {
      throw new Error("Not implemented in test");
    },
    print: params.print,
  };
}
