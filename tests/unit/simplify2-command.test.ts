import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import simplify2Procedure from "../../procedures/simplify2.ts";
import type {
  CommandContext,
  DownstreamAgentConfig,
  ProcedureResult,
  RunResult,
} from "../../src/core/types.ts";

describe("simplify2 procedure", () => {
  test("starts paused on a typed checkpoint and creates inspectable artifacts", async () => {
    const cwd = createFixtureWorkspace();
    const prompts: string[] = [];

    const result = await simplify2Procedure.execute(
      "",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-duplicate-boundary",
            kind: "boundary_candidate",
            summary: "Continuation parsing appears to be split across two layers.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            confidence: "medium",
          },
        ]),
        hypothesisBatch([
          {
            id: "hyp-boundary-checkpoint",
            title: "Collapse duplicate continuation parsing ownership",
            kind: "collapse_boundary",
            summary: "A fake boundary duplicates continuation parsing logic.",
            rationale: "One owner should enforce the parsing invariant.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            expectedDelta: {
              boundariesReduced: 1,
              duplicateRepresentationsReduced: 1,
            },
            risk: "medium",
            needsHumanCheckpoint: true,
            checkpointReason: "This changes which layer owns continuation parsing.",
            implementationScope: ["src/session/repository.ts", "src/core/service.ts"],
            testImplications: ["strengthen invariant coverage around continuation parsing"],
          },
        ]),
        rankingBatch([
          {
            hypothesisId: "hyp-boundary-checkpoint",
            score: 9,
            reason: "High conceptual reduction but the ownership move needs confirmation.",
            needsHumanCheckpoint: true,
          },
        ]),
      ], prompts),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.pause?.question).toContain("Collapse duplicate continuation parsing ownership");
    expect(normalized.display).toContain("Simplify2 iteration 1");
    expect(prompts[0]).toContain("Current focus: simplify the current project");

    const pausedState = normalized.pause?.state as {
      mode: string;
      notebook: { currentCheckpoint?: { hypothesisId: string } };
    };
    expect(pausedState.mode).toBe("checkpoint");
    expect(pausedState.notebook.currentCheckpoint?.hypothesisId).toBe("hyp-boundary-checkpoint");

    expect(existsSync(join(cwd, ".nanoboss", "simplify2", "architecture-memory.json"))).toBe(true);
    expect(existsSync(join(cwd, ".nanoboss", "simplify2", "journal.json"))).toBe(true);
    expect(existsSync(join(cwd, ".nanoboss", "simplify2", "test-map.json"))).toBe(true);
  });

  test("auto-applies a low-risk slice, continues analysis, and finishes when no next slice stands out", async () => {
    const cwd = createFixtureWorkspace({
      sourceFiles: ["src/session/repository.ts"],
      tests: [
        {
          path: "tests/unit/current-session.test.ts",
          contents: [
            'import { expect, test } from "bun:test";',
            'test("placeholder validation", () => {',
            "  expect(true).toBe(true);",
            "});",
          ].join("\n"),
        },
      ],
    });

    const result = await simplify2Procedure.execute(
      "focus on continuation persistence",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-dup-parsing",
            kind: "duplication",
            summary: "Continuation parsing is duplicated in the session flow.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            confidence: "high",
          },
        ]),
        hypothesisBatch([
          {
            id: "hyp-canonicalize-parsing",
            title: "Canonicalize continuation parsing",
            kind: "canonicalize_representation",
            summary: "Use one representation for continuation parsing across the session flow.",
            rationale: "This removes duplicate parsing logic and sharpens the invariant.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            expectedDelta: {
              duplicateRepresentationsReduced: 1,
            },
            risk: "low",
            needsHumanCheckpoint: false,
            implementationScope: ["src/session/repository.ts"],
            testImplications: ["keep a narrow invariant test for current session parsing"],
          },
        ]),
        rankingBatch([
          {
            hypothesisId: "hyp-canonicalize-parsing",
            score: 8,
            reason: "Small, coherent, and high-value cleanup.",
            needsHumanCheckpoint: false,
          },
        ]),
        {
          summary: "Canonicalized the continuation parsing path around a single representation.",
          touchedFiles: ["src/session/repository.ts"],
          conceptualChanges: ["one representation now owns continuation parsing"],
          testChanges: ["kept the current session invariant test narrow"],
          validationNotes: ["expected unit test slice should pass"],
        },
        {
          journalSummary: "Recorded the parsing canonicalization as the new baseline.",
          memorySummary: "Continuation parsing now has one canonical representation.",
          memoryUpdates: {
            concepts: ["continuation parsing"],
            invariants: ["one canonical continuation representation"],
            boundaries: ["session persistence"],
            exceptions: [],
            staleItems: [],
          },
          nextQuestions: [],
          resolvedHypothesisIds: ["hyp-canonicalize-parsing"],
          followupRecommendations: ["Look for adjacent continuation test smells on the next run."],
        },
        emptyRefreshProposal(),
        observationBatch([]),
        hypothesisBatch([]),
        rankingBatch([]),
      ]),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.pause).toBeUndefined();
    expect(normalized.display).toContain("Applied: Canonicalize continuation parsing.");
    expect(normalized.display).toContain("Validation: passed.");
    expect(normalized.display).toContain("No worthwhile simplification hypothesis stood out after the current review cycle.");

    const testMap = readFileSync(join(cwd, ".nanoboss", "simplify2", "test-map.json"), "utf8");
    expect(testMap).toContain("tests/unit/current-session.test.ts");
  });

  test("auto-applies one slice and can then pause on a later checkpoint", async () => {
    const cwd = createFixtureWorkspace({
      sourceFiles: ["src/session/repository.ts", "src/core/service.ts"],
      tests: [
        {
          path: "tests/unit/current-session.test.ts",
          contents: [
            'import { expect, test } from "bun:test";',
            'test("current session slice", () => {',
            "  expect(1 + 1).toBe(2);",
            "});",
          ].join("\n"),
        },
      ],
    });

    const result = await simplify2Procedure.execute(
      "focus on continuation persistence",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-dup-parsing",
            kind: "duplication",
            summary: "Continuation parsing is duplicated in the session flow.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            confidence: "high",
          },
        ]),
        hypothesisBatch([
          {
            id: "hyp-canonicalize-parsing",
            title: "Canonicalize continuation parsing",
            kind: "canonicalize_representation",
            summary: "Use one representation for continuation parsing across the session flow.",
            rationale: "This removes duplicate parsing logic and sharpens the invariant.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            expectedDelta: {
              duplicateRepresentationsReduced: 1,
            },
            risk: "low",
            needsHumanCheckpoint: false,
            implementationScope: ["src/session/repository.ts"],
            testImplications: ["keep a narrow invariant test for current session parsing"],
          },
        ]),
        rankingBatch([
          {
            hypothesisId: "hyp-canonicalize-parsing",
            score: 8,
            reason: "Small, coherent, and high-value cleanup.",
            needsHumanCheckpoint: false,
          },
        ]),
        {
          summary: "Canonicalized the continuation parsing path around a single representation.",
          touchedFiles: ["src/session/repository.ts"],
          conceptualChanges: ["one representation now owns continuation parsing"],
          testChanges: ["kept the current session invariant test narrow"],
          validationNotes: ["expected unit test slice should pass"],
        },
        {
          journalSummary: "Recorded the parsing canonicalization as the new baseline.",
          memorySummary: "Continuation parsing now has one canonical representation.",
          memoryUpdates: {
            concepts: ["continuation parsing"],
            invariants: ["one canonical continuation representation"],
            boundaries: ["session persistence"],
            exceptions: [],
            staleItems: [],
          },
          nextQuestions: [],
          resolvedHypothesisIds: ["hyp-canonicalize-parsing"],
          followupRecommendations: ["Look for ownership ambiguity around continuation persistence."],
        },
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-ownership-boundary",
            kind: "boundary_candidate",
            summary: "The service and repository both appear to influence continuation persistence semantics.",
            evidence: [{ kind: "file", ref: "src/core/service.ts" }],
            confidence: "medium",
          },
        ]),
        hypothesisBatch([
          {
            id: "hyp-boundary-checkpoint",
            title: "Challenge continuation persistence ownership",
            kind: "collapse_boundary",
            summary: "The ownership split may be fake and should be reviewed before any move.",
            rationale: "One layer may be able to own the continuation persistence invariant.",
            evidence: [{ kind: "file", ref: "src/core/service.ts" }],
            expectedDelta: {
              boundariesReduced: 1,
            },
            risk: "medium",
            needsHumanCheckpoint: true,
            checkpointReason: "This may change which layer owns continuation persistence semantics.",
            implementationScope: ["src/core/service.ts", "src/session/repository.ts"],
            testImplications: ["confirm the ownership boundary before changing behavior"],
          },
        ]),
        rankingBatch([
          {
            hypothesisId: "hyp-boundary-checkpoint",
            score: 7,
            reason: "Strong follow-up, but it needs a checkpoint.",
            needsHumanCheckpoint: true,
          },
        ]),
      ]),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.display).toContain("Applied: Canonicalize continuation parsing.");
    expect(normalized.pause?.question).toContain("Challenge continuation persistence ownership");
  });

  test("resume can approve a paused checkpoint, apply the selected hypothesis, and continue to completion", async () => {
    const cwd = createFixtureWorkspace({
      sourceFiles: ["src/session/repository.ts"],
      tests: [
        {
          path: "tests/unit/current-session.test.ts",
          contents: [
            'import { expect, test } from "bun:test";',
            'test("current session slice", () => {',
            "  expect(1 + 1).toBe(2);",
            "});",
          ].join("\n"),
        },
      ],
    });

    const executeResult = await simplify2Procedure.execute(
      "",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-dup-boundary",
            kind: "boundary_candidate",
            summary: "Two layers still share continuation parsing responsibilities.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            confidence: "medium",
          },
        ]),
        hypothesisBatch([
          {
            id: "hyp-approve-me",
            title: "Collapse continuation parsing ownership",
            kind: "collapse_boundary",
            summary: "Pick one layer to own continuation parsing.",
            rationale: "This removes duplicated parsing decisions.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            expectedDelta: {
              boundariesReduced: 1,
            },
            risk: "medium",
            needsHumanCheckpoint: true,
            checkpointReason: "Ownership changes should be reviewed before apply.",
            implementationScope: ["src/session/repository.ts"],
            testImplications: ["keep current session parsing covered"],
          },
        ]),
        rankingBatch([
          {
            hypothesisId: "hyp-approve-me",
            score: 7,
            reason: "Worth doing after a human checkpoint.",
            needsHumanCheckpoint: true,
          },
        ]),
      ]),
    );

    const pausedState = requirePauseState(normalizeProcedureResult(executeResult));
    const resumeResult = await simplify2Procedure.resume(
      "approve it",
      pausedState,
      createMockContext(cwd, [
        {
          kind: "approve_hypothesis",
          reason: "The ownership change is fine.",
          hypothesisId: "hyp-approve-me",
        },
        {
          summary: "Moved continuation parsing ownership into the repository layer.",
          touchedFiles: ["src/session/repository.ts"],
          conceptualChanges: ["one owner now enforces parsing invariants"],
          testChanges: ["kept the current-session unit test aligned with the invariant"],
          validationNotes: ["selected unit slice should pass"],
        },
        {
          journalSummary: "Recorded the ownership collapse as the preferred design.",
          memorySummary: "The repository layer now owns continuation parsing.",
          memoryUpdates: {
            concepts: ["continuation parsing"],
            invariants: ["repository owns parsing invariants"],
            boundaries: ["session repository"],
            exceptions: [],
            staleItems: [],
          },
          nextQuestions: [],
          resolvedHypothesisIds: ["hyp-approve-me"],
          followupRecommendations: [],
        },
        emptyRefreshProposal(),
        observationBatch([]),
        hypothesisBatch([]),
        rankingBatch([]),
      ]),
    );

    const normalized = normalizeProcedureResult(resumeResult);
    expect(normalized.display).toContain("Applied: Collapse continuation parsing ownership.");
    expect(normalized.display).toContain("Validation: passed.");
    expect(normalized.display).toContain("No worthwhile simplification hypothesis stood out after the current review cycle.");
    expect(normalized.data).toMatchObject({
      appliedCount: 1,
      latestHypothesis: "Collapse continuation parsing ownership",
      validationStatus: "passed",
    });
  });

  test("resume can apply a typed design update and rerun the checkpoint flow", async () => {
    const cwd = createFixtureWorkspace();

    const executeResult = await simplify2Procedure.execute(
      "",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-boundary",
            kind: "boundary_candidate",
            summary: "The service boundary looks fake but might reflect deployment reality.",
            evidence: [{ kind: "file", ref: "src/core/service.ts" }],
            confidence: "medium",
          },
        ]),
        hypothesisBatch([
          {
            id: "hyp-boundary-revisit",
            title: "Collapse the service/session boundary",
            kind: "collapse_boundary",
            summary: "There may be a fake boundary between service and session handling.",
            rationale: "Removing it would reduce translation layers.",
            evidence: [{ kind: "file", ref: "src/core/service.ts" }],
            expectedDelta: {
              boundariesReduced: 1,
            },
            risk: "medium",
            needsHumanCheckpoint: true,
            checkpointReason: "This may conflict with intentional deployment separation.",
            implementationScope: ["src/core/service.ts"],
            testImplications: ["revisit only if the boundary is not real"],
          },
        ]),
        rankingBatch([
          {
            hypothesisId: "hyp-boundary-revisit",
            score: 7,
            reason: "Promising but ambiguous without architectural input.",
            needsHumanCheckpoint: true,
          },
        ]),
      ]),
    );

    const pausedState = requirePauseState(normalizeProcedureResult(executeResult));
    const resumePrompts: string[] = [];
    const resumeResult = await simplify2Procedure.resume(
      "the boundary is real because it reflects deployment constraints",
      pausedState,
      createMockContext(cwd, [
        {
          kind: "design_update",
          reason: "Deployment constraints make the service boundary real.",
          designUpdate: {
            updateKind: "boundary_status_change",
            target: "service/session boundary",
            newStatus: "canonical",
            summary: "Keep the service/session boundary explicit because it maps to deployment reality.",
          },
        },
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-test-smell",
            kind: "test_smell",
            summary: "Tests still duplicate setup around the real service boundary.",
            evidence: [{ kind: "test", ref: "tests/unit/tui-controller.test.ts" }],
            confidence: "medium",
          },
        ]),
        hypothesisBatch([
          {
            id: "hyp-simplify-tests",
            title: "Simplify duplicated boundary test setup",
            kind: "simplify_tests",
            summary: "Reduce duplicate test setup while preserving the real service boundary.",
            rationale: "Now that the boundary is explicit, the simplification target should move to tests.",
            evidence: [{ kind: "test", ref: "tests/unit/tui-controller.test.ts" }],
            expectedDelta: {
              testRuntimeDelta: "lower",
            },
            risk: "medium",
            needsHumanCheckpoint: true,
            checkpointReason: "Test cleanup still changes what the suite documents.",
            implementationScope: ["tests/unit/tui-controller.test.ts"],
            testImplications: ["preserve real-boundary coverage while reducing duplication"],
          },
        ]),
        rankingBatch([
          {
            hypothesisId: "hyp-simplify-tests",
            score: 6,
            reason: "Better follow-up after accepting the real boundary.",
            needsHumanCheckpoint: true,
          },
        ]),
      ], resumePrompts),
    );

    const normalized = normalizeProcedureResult(resumeResult);
    expect(normalized.pause?.question).toContain("Simplify duplicated boundary test setup");
    expect(resumePrompts[0]).toContain("Current checkpoint:");

    const memory = readFileSync(join(cwd, ".nanoboss", "simplify2", "architecture-memory.json"), "utf8");
    expect(memory).toContain("Keep the service/session boundary explicit because it maps to deployment reality.");
    expect(memory).toContain("service/session boundary");
  });
});

function createFixtureWorkspace(params?: {
  sourceFiles?: string[];
  tests?: Array<{ path: string; contents: string }>;
}): string {
  const cwd = mkdtempSync(join(tmpdir(), "simplify2-"));
  writeFileSync(join(cwd, "package.json"), '{ "name": "simplify2-fixture", "type": "module" }\n', "utf8");

  for (const path of params?.sourceFiles ?? []) {
    const filePath = join(cwd, path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const placeholder = true;\n", "utf8");
  }

  for (const testFile of params?.tests ?? []) {
    const filePath = join(cwd, testFile.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${testFile.contents}\n`, "utf8");
  }

  return cwd;
}

function emptyRefreshProposal() {
  return {
    newObservations: [],
    staleItems: [],
    suspectConceptMerges: [],
    suspectBoundaryCollapses: [],
    invariantCandidates: [],
    designEvolutionSignals: [],
  };
}

function observationBatch(observations: unknown[]) {
  return { observations };
}

function hypothesisBatch(hypotheses: unknown[]) {
  return { hypotheses };
}

function rankingBatch(rankings: unknown[]) {
  return { rankings };
}

function createMockContext(
  cwd: string,
  agentResults: unknown[],
  prompts: string[] = [],
): CommandContext {
  let callCount = 0;
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "copilot",
    command: "bun",
    args: [],
    cwd,
  };

  return {
    cwd,
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
    callAgent: (async (prompt: string) => {
      prompts.push(prompt);
      callCount += 1;
      const next = agentResults.shift();
      if (next === undefined) {
        throw new Error(`Unexpected callAgent #${callCount}`);
      }
      return {
        cell: {
          sessionId: "test-session",
          cellId: `agent-${callCount}`,
        },
        data: next,
      } as RunResult<unknown>;
    }) as CommandContext["callAgent"],
    async callProcedure() {
      throw new Error("Not implemented in test");
    },
    print() {},
  };
}

function normalizeProcedureResult(value: ProcedureResult | string | void): ProcedureResult {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    return { display: value };
  }

  return value;
}

function requirePauseState(result: ProcedureResult): NonNullable<NonNullable<ProcedureResult["pause"]>["state"]> {
  const pausedState = result.pause?.state;
  expect(pausedState).toBeDefined();
  if (!pausedState) {
    throw new Error("Expected procedure result to include pause state");
  }
  return pausedState;
}
