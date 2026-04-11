import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import researchProcedure from "../../procedures/research.ts";
import type {
  CommandContext,
  DownstreamAgentConfig,
  RunResult,
} from "../../src/core/types.ts";

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
  test("uses a default-session brief before dispatching isolated research", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nab-research-"));
    tempDirs.push(cwd);

    const prints: string[] = [];
    const calls: Array<{
      prompt: string;
      descriptor?: unknown;
      options?: unknown;
    }> = [];
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
        uiText: (text) => {
          prints.push(text);
        },
        agentRun: async (prompt: string, descriptorOrOptions?: unknown, maybeOptions?: unknown) => {
          const descriptor = isDescriptor(descriptorOrOptions) ? descriptorOrOptions : undefined;
          const options = (descriptor ? maybeOptions : descriptorOrOptions) as
            | Record<string, unknown>
            | undefined;

          calls.push({
            prompt,
            descriptor,
            options,
          });

          if (calls.length === 1) {
            return {
              cell: {
                sessionId: "test-session",
                cellId: "brief-cell",
              },
              data: {
                researchQuestion: "What changed in the pi-tui update?",
                contextSummary: "The user wants a concise summary of the renderer migration.",
                mustCover: ["what changed", "why it matters"],
                constraints: ["keep it concise"],
              },
              dataRef: {
                cell: {
                  sessionId: "test-session",
                  cellId: "brief-cell",
                },
                path: "data",
              },
            } satisfies RunResult;
          }

          return {
            cell: {
              sessionId: "test-session",
              cellId: "report-cell",
            },
            data: {
              report,
              abstract,
              descriptionWords: ["pi", "tui", "review"],
            },
            dataRef: {
              cell: {
                sessionId: "test-session",
                cellId: "report-cell",
              },
              path: "data",
            },
          } satisfies RunResult;
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
    expect(calls).toHaveLength(2);
    const firstCall = calls[0];
    const secondCall = calls[1];
    if (!firstCall || !secondCall) {
      throw new Error("Expected two callAgent invocations");
    }
    expect(firstCall.prompt).toContain("You are preparing a research brief for a separate worker agent.");
    expect(firstCall.prompt).toContain("User request:\nsummarize the pi-tui update");
    expect(isDescriptor(firstCall.descriptor)).toBe(true);
    expect(firstCall.options).toEqual({
      session: "default",
      stream: false,
    });
    expect(secondCall.prompt).toContain("You are a research agent working from the referenced brief `brief`.");
    expect(secondCall.prompt).toContain("Original user request:\nsummarize the pi-tui update");
    expect(isDescriptor(secondCall.descriptor)).toBe(true);
    expect(secondCall.options).toEqual({
      refs: {
        brief: {
          cell: {
            sessionId: "test-session",
            cellId: "brief-cell",
          },
          path: "data",
        },
      },
      stream: false,
    });
    expect(prints).toContain("Preparing a research brief from the current conversation...\n");
    expect(prints).toContain("Dispatching an isolated research agent...\n");
    expect(prints).toContain("Starting research...\n");
    expect(prints).toContain(`Wrote detailed report to ${relativePath}.\n`);
    expect(prints).toContain("Completed research.\n");
  });
});

function createMockContext(params: {
  cwd: string;
  uiText(text: string): void;
  agentRun(prompt: string, descriptorOrOptions?: unknown, maybeOptions?: unknown): Promise<RunResult>;
}): CommandContext {
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "copilot",
    command: "bun",
    args: [],
    cwd: params.cwd,
  };
  const refs: CommandContext["refs"] = {
    async read() {
      throw new Error("Not implemented in test");
    },
    async stat() {
      throw new Error("Not implemented in test");
    },
    async writeToFile() {
      throw new Error("Not implemented in test");
    },
  };
  const session: CommandContext["session"] = {
    async recent() {
      return [];
    },
    async latest() {
      return undefined;
    },
    async topLevelRuns() {
      return [];
    },
    async get() {
      throw new Error("Not implemented in test");
    },
    async parent() {
      return undefined;
    },
    async children() {
      return [];
    },
    async ancestors() {
      return [];
    },
    async descendants() {
      return [];
    },
  };
  const agent: CommandContext["agent"] = {
    run: params.agentRun as CommandContext["agent"]["run"],
    session() {
      return {
        run: params.agentRun as CommandContext["agent"]["run"],
      };
    },
  };
  const ui: CommandContext["ui"] = {
    text: params.uiText,
    info(text) {
      params.uiText(`INFO:${text}`);
    },
    warning(text) {
      params.uiText(`WARNING:${text}`);
    },
    error(text) {
      params.uiText(`ERROR:${text}`);
    },
    status() {
      throw new Error("Not implemented in test");
    },
    card() {
      throw new Error("Not implemented in test");
    },
  };

  return {
    cwd: params.cwd,
    sessionId: "test-session",
    agent,
    state: {
      runs: session,
      refs,
    },
    ui,
    procedures: {
      async run() {
        throw new Error("Not implemented in test");
      },
    },
    refs,
    session,
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
    async callAgent() {
      throw new Error("Legacy ctx.callAgent shim should not be used in this test");
    },
    async callProcedure() {
      throw new Error("Not implemented in test");
    },
    print() {
      throw new Error("Legacy ctx.print shim should not be used in this test");
    },
  };
}

function isDescriptor(value: unknown): boolean {
  return Boolean(
    value
      && typeof value === "object"
      && "schema" in value
      && "validate" in value,
  );
}
