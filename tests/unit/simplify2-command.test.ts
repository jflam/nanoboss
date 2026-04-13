import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import simplify2Procedure from "../../procedures/simplify2.ts";
import type {
  ProcedureApi,
  DownstreamAgentConfig,
  ProcedureResult,
  RunResult,
} from "../../src/core/types.ts";

describe("simplify2 procedure", () => {
  test("blocks execute when the git worktree is dirty", async () => {
    const cwd = createFixtureWorkspace();
    writeFileSync(join(cwd, "dirty.txt"), "not committed\n", "utf8");

    const result = await simplify2Procedure.execute(
      "focus on continuation persistence",
      createMockContext(cwd, []),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.summary).toBe("simplify2: blocked by dirty worktree");
    expect(normalized.display).toContain("Simplify2 requires a clean git worktree");
    expect(normalized.display).toContain("?? dirty.txt");
  });

  test("starts paused on a typed checkpoint and creates inspectable artifacts", async () => {
    const cwd = createFixtureWorkspace();
    const prompts: string[] = [];

    const result = await simplify2Procedure.execute(
      "simplify the current project",
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
    expect(normalized.display).toContain("Iteration 1/1");
    expect(normalized.display).toContain("I have a simplification proposal:");
    expect(normalized.display).toContain("I have proposed 1 hypotheses for this simplification:");
    expect(normalized.display).toContain("I have selected hypothesis \"Collapse duplicate continuation parsing ownership\":");
    expect(prompts[0]).toContain("Current focus: simplify the current project");

    const pausedState = normalized.pause?.state as {
      mode: string;
      notebook: { currentCheckpoint?: { hypothesisId: string } };
    };
    expect(pausedState.mode).toBe("checkpoint");
    expect(pausedState.notebook.currentCheckpoint?.hypothesisId).toMatch(/^hyp-[0-9a-f]{12}$/);
    expect(pausedState.notebook.currentCheckpoint?.hypothesisId).not.toBe("hyp-boundary-checkpoint");
    expect(normalized.pause?.continuationUi).toMatchObject({
      kind: "simplify2_checkpoint",
      actions: [
        { id: "approve", reply: "approve it" },
        { id: "stop", reply: "stop" },
        { id: "focus_tests", reply: "focus on tests instead" },
        { id: "other" },
      ],
    });

    const focusDir = findOnlyFocusDir(cwd);
    expect(existsSync(join(cwd, ".nanoboss", "simplify2", "index.json"))).toBe(true);
    expect(existsSync(join(focusDir, "architecture-memory.json"))).toBe(true);
    expect(existsSync(join(focusDir, "journal.json"))).toBe(true);
    expect(existsSync(join(focusDir, "test-map.json"))).toBe(true);
    expect(existsSync(join(focusDir, "observations.json"))).toBe(true);
    expect(existsSync(join(focusDir, "analysis-cache.json"))).toBe(true);
  });

  test("accepts a max-iterations directive in the prompt", async () => {
    const cwd = createFixtureWorkspace();
    const prompts: string[] = [];

    const result = await simplify2Procedure.execute(
      "max 5 iterations focus on continuation persistence",
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
    expect(normalized.display).toContain("Iteration 1/5");
    expect(prompts[0]).toContain("Current focus: focus on continuation persistence");
    expect(prompts[0]).not.toContain("max 5 iterations");
    expect((normalized.pause?.state as { maxIterations: number }).maxIterations).toBe(5);
  });

  test("keeps a paused checkpoint when resume hits a dirty worktree", async () => {
    const cwd = createFixtureWorkspace();

    const executeResult = await simplify2Procedure.execute(
      "focus on continuation persistence",
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
      ]),
    );

    writeFileSync(join(cwd, "dirty.txt"), "not committed\n", "utf8");

    const resumeResult = await simplify2Procedure.resume(
      "approve it",
      requirePauseState(normalizeProcedureResult(executeResult)),
      createMockContext(cwd, [
        {
          kind: "approve_hypothesis",
          reason: "Proceed.",
          hypothesisId: "hyp-boundary-checkpoint",
        },
      ]),
    );

    const normalized = normalizeProcedureResult(resumeResult);
    expect(normalized.pause?.question).toContain("Should I approve this slice");
    expect(normalized.display).toContain("Simplify2 cannot continue until the git worktree is clean again.");
    expect(normalized.display).toContain("?? dirty.txt");
  });

  test("keeps a paused checkpoint when redirect resume hits a dirty worktree", async () => {
    const cwd = createFixtureWorkspace();

    const executeResult = await simplify2Procedure.execute(
      "focus on continuation persistence",
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
      ]),
    );

    writeFileSync(join(cwd, "dirty.txt"), "not committed\n", "utf8");

    const resumeResult = await simplify2Procedure.resume(
      "focus on tests instead",
      requirePauseState(normalizeProcedureResult(executeResult)),
      createMockContext(cwd, [
        {
          kind: "redirect",
          reason: "Look for a smaller test cleanup first.",
          redirect: {
            goals: ["focus on tests first"],
            guidance: "Prefer a small test-only slice before changing ownership.",
          },
        },
      ]),
    );

    const normalized = normalizeProcedureResult(resumeResult);
    expect(normalized.pause?.question).toContain("Should I approve this slice");
    expect(normalized.display).toContain("Simplify2 cannot continue until the git worktree is clean again.");
    expect(normalized.display).toContain("?? dirty.txt");
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
      ]),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.pause).toBeUndefined();
    expect(normalized.display).toContain("Applied: Canonicalize continuation parsing.");
    expect(normalized.display).toContain("Why this change:");
    expect(normalized.display).toContain("- selected because: Small, coherent, and high-value cleanup.");
    expect(normalized.display).toContain("- conceptual rationale: This removes duplicate parsing logic and sharpens the invariant.");
    expect(normalized.display).toContain("- realized conceptual changes: one representation now owns continuation parsing");
    expect(normalized.display).toContain("Validation: passed.");
    expect(normalized.display).toContain("Landed one simplify2 slice for this focus after applying Canonicalize continuation parsing.");

    const testMap = readFileSync(join(findOnlyFocusDir(cwd), "test-map.json"), "utf8");
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
      "max 2 iterations focus on continuation persistence",
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
    expect(normalized.display).toContain("Why this change:");
    expect(normalized.display).toContain("- selected because: Small, coherent, and high-value cleanup.");
    expect(normalized.display).toContain("- realized conceptual changes: one representation now owns continuation parsing");
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
      "focus on continuation persistence",
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

    const procedureCalls: Array<{ name: string; prompt: string }> = [];
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
      ], [], {
        procedureCalls,
      }),
    );

    const normalized = normalizeProcedureResult(resumeResult);
    expect(normalized.display).toContain("Applied: Collapse continuation parsing ownership.");
    expect(normalized.display).toContain("Why this change:");
    expect(normalized.display).toContain("- selected because: Worth doing after a human checkpoint.");
    expect(normalized.display).toContain("- checkpoint context: Ownership changes should be reviewed before apply.");
    expect(normalized.display).toContain("- conceptual rationale: This removes duplicated parsing decisions.");
    expect(normalized.display).toContain("- realized conceptual changes: one owner now enforces parsing invariants");
    expect(normalized.display).toContain("Validation: passed.");
    expect(normalized.display).toContain("Commit: created.");
    expect(normalized.display).toContain("Landed one simplify2 slice for this focus after applying Collapse continuation parsing ownership.");
    expect(procedureCalls).toHaveLength(1);
    const commitCall = procedureCalls[0];
    expect(commitCall).toBeDefined();
    expect(commitCall?.name).toBe("nanoboss/commit");
    expect(commitCall?.prompt).toContain("commit the simplify2 slice \"Collapse continuation parsing ownership\"");
    expect(normalized.data).toMatchObject({
      appliedCount: 1,
      latestHypothesis: "Collapse continuation parsing ownership",
      validationStatus: "passed",
    });
  });

  test("stops after an automatic commit failure with a clear display", async () => {
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
          followupRecommendations: [],
        },
      ], [], {
        procedureResults: [
          {
            cell: {
              sessionId: "test-session",
              cellId: "procedure-commit",
            },
            data: {
              checks: {
                passed: false,
              },
            },
            display: "Pre-commit checks failed. Commit was not created.\n",
            summary: "nanoboss/commit: blocked by failing pre-commit checks",
          },
        ],
      }),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.display).toContain("Commit: failed.");
    expect(normalized.display).toContain("Automatic commit failed after applying Canonicalize continuation parsing.");
    expect(normalized.data).toMatchObject({
      appliedCount: 1,
      latestHypothesis: "Canonicalize continuation parsing",
    });
  });

  test("resume can apply a typed design update and rerun the checkpoint flow", async () => {
    const cwd = createFixtureWorkspace();

    const executeResult = await simplify2Procedure.execute(
      "focus on service boundary semantics",
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

    const memory = readFileSync(join(findOnlyFocusDir(cwd), "architecture-memory.json"), "utf8");
    expect(memory).toContain("Keep the service/session boundary explicit because it maps to deployment reality.");
    expect(memory).toContain("service/session boundary");
  });

  test("reuses cached observations on a narrow follow-up iteration instead of rerunning a full refresh", async () => {
    const cwd = createFixtureWorkspace({
      sourceFiles: [
        "src/session/repository.ts",
        "src/session/helpers.ts",
        "src/session/formatter.ts",
      ],
      tests: [
        {
          path: "tests/unit/current-session.test.ts",
          contents: [
            'import { expect, test } from "bun:test";',
            'test("current session slice", () => {',
            "  expect(true).toBe(true);",
            "});",
          ].join("\n"),
        },
      ],
    });
    const prompts: string[] = [];

    const result = await simplify2Procedure.execute(
      "max 2 iterations focus on continuation persistence",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-repo",
            kind: "duplication",
            summary: "Continuation parsing is duplicated in the repository path.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            confidence: "high",
          },
          {
            id: "obs-helper",
            kind: "test_smell",
            summary: "Helper tests duplicate formatting setup around current sessions.",
            evidence: [{ kind: "file", ref: "src/session/helpers.ts" }],
            confidence: "medium",
          },
          {
            id: "obs-formatter",
            kind: "duplication",
            summary: "Formatter setup drifts from the repository invariant wording.",
            evidence: [{ kind: "file", ref: "src/session/formatter.ts" }],
            confidence: "medium",
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
        observationBatch([]),
        hypothesisBatch([]),
        rankingBatch([]),
      ], prompts),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.display).toContain("No worthwhile simplification hypothesis stood out after the current review cycle.");
    expect(prompts.filter((prompt) => prompt.includes("helping maintain durable architecture memory")).length).toBe(1);
    expect(prompts.filter((prompt) => prompt.includes("Scope this observation refresh to these changed paths first")).length).toBe(1);
    expect(prompts.some((prompt) => prompt.includes("Reuse the notebook context as preserved observations"))).toBe(true);

    const analysisCache = readFileSync(join(findOnlyFocusDir(cwd), "analysis-cache.json"), "utf8");
    expect(analysisCache).toContain("\"reusableObservationIds\"");
    expect(analysisCache).toContain("\"staleObservationIds\"");
  });

  test("suppresses a near-duplicate follow-up hypothesis after applying the same seam", async () => {
    const cwd = createFixtureWorkspace({
      sourceFiles: ["src/session/repository.ts"],
      tests: [
        {
          path: "tests/unit/current-session.test.ts",
          contents: [
            'import { expect, test } from "bun:test";',
            'test("current session slice", () => {',
            "  expect(true).toBe(true);",
            "});",
          ].join("\n"),
        },
      ],
    });

    const result = await simplify2Procedure.execute(
      "max 2 iterations focus on continuation persistence",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-repo",
            kind: "duplication",
            summary: "Continuation parsing is duplicated in the repository path.",
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
          followupRecommendations: [],
        },
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-repo-repeat",
            kind: "duplication",
            summary: "Continuation parsing is duplicated in the repository path.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            confidence: "high",
          },
        ]),
        hypothesisBatch([
          {
            id: "hyp-canonicalize-parsing-again",
            title: "Canonicalize continuation parsing",
            kind: "canonicalize_representation",
            summary: "Use one representation for continuation parsing across the session flow.",
            rationale: "This removes duplicate parsing logic and sharpens the invariant.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            expectedDelta: {
              duplicateRepresentationsReduced: 1,
            },
            risk: "medium",
            needsHumanCheckpoint: false,
            implementationScope: ["src/session/repository.ts"],
            testImplications: ["keep a narrow invariant test for current session parsing"],
          },
        ]),
        rankingBatch([
          {
            hypothesisId: "hyp-canonicalize-parsing-again",
            score: 9,
            reason: "Looks strong but is effectively the same seam.",
            needsHumanCheckpoint: false,
          },
        ]),
      ]),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.pause).toBeUndefined();
    expect(normalized.display).toContain("No worthwhile simplification hypothesis stood out after the current review cycle.");
  });

  test("does not suppress a new core hypothesis just because a later iteration reused the same batch-local id", async () => {
    const cwd = createFixtureWorkspace({
      sourceFiles: ["src/session/repository.ts", "src/tui/controller.ts"],
      tests: [
        {
          path: "tests/unit/current-session.test.ts",
          contents: [
            'import { expect, test } from "bun:test";',
            'test("current session slice", () => {',
            "  expect(true).toBe(true);",
            "});",
          ].join("\n"),
        },
      ],
    });

    const result = await simplify2Procedure.execute(
      "max 2 iterations focus on continuation persistence",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-repo",
            kind: "duplication",
            summary: "Continuation parsing is duplicated in the repository path.",
            evidence: [{ kind: "file", ref: "src/session/repository.ts" }],
            confidence: "high",
          },
        ]),
        hypothesisBatch([
          {
            id: "H1",
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
            hypothesisId: "H1",
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
          resolvedHypothesisIds: ["H1"],
          followupRecommendations: [],
        },
        emptyRefreshProposal(),
        observationBatch([
          {
            id: "obs-transport",
            kind: "boundary_candidate",
            summary: "Transport liveness is modeled separately from retained run lifecycle.",
            evidence: [{ kind: "file", ref: "src/tui/controller.ts" }],
            confidence: "medium",
          },
        ]),
        hypothesisBatch([
          {
            id: "H1",
            title: "Unify transport liveness with retained run lifecycle",
            kind: "centralize_invariant",
            summary: "Represent disconnect and reconnect state inside one retained lifecycle model.",
            rationale: "This removes the fake boundary between transport health and run lifecycle.",
            evidence: [{ kind: "file", ref: "src/tui/controller.ts" }],
            expectedDelta: {
              conceptsReduced: 1,
              boundariesReduced: 1,
            },
            risk: "medium",
            needsHumanCheckpoint: true,
            checkpointReason: "The lifecycle contract should be reviewed before changing transport state semantics.",
            implementationScope: ["src/tui/controller.ts"],
            testImplications: ["add one lifecycle-focused test after clarifying the contract"],
          },
        ]),
        rankingBatch([
          {
            hypothesisId: "H1",
            score: 9,
            reason: "High-value lifecycle cleanup that still needs a checkpoint.",
            needsHumanCheckpoint: true,
          },
        ]),
      ]),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.pause?.question).toContain("Unify transport liveness with retained run lifecycle");
    expect(normalized.display).toContain("Applied: Canonicalize continuation parsing.");
  });

  test("bare simplify2 opens a focus picker when no saved focuses exist", async () => {
    const cwd = createFixtureWorkspace();

    const result = await simplify2Procedure.execute(
      "",
      createMockContext(cwd, []),
    );

    const normalized = normalizeProcedureResult(result);
    expect(normalized.summary).toBe("simplify2: choose focus");
    expect(normalized.pause?.continuationUi).toMatchObject({
      kind: "simplify2_focus_picker",
      actions: [
        { id: "continue" },
        { id: "archive" },
        { id: "new" },
        { id: "cancel" },
      ],
    });
    expect(normalized.pause?.question).toContain("No saved simplify focuses");
  });

  test("stores different focuses in separate per-focus directories", async () => {
    const cwd = createFixtureWorkspace();

    const first = await simplify2Procedure.execute(
      "focus on session metadata",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([]),
        hypothesisBatch([]),
        rankingBatch([]),
      ]),
    );
    const second = await simplify2Procedure.execute(
      "focus on continuation persistence",
      createMockContext(cwd, [
        emptyRefreshProposal(),
        observationBatch([]),
        hypothesisBatch([]),
        rankingBatch([]),
      ]),
    );

    expect(normalizeProcedureResult(first).summary).toContain("simplify2: finished");
    expect(normalizeProcedureResult(second).summary).toContain("simplify2: finished");

    const focusesRoot = join(cwd, ".nanoboss", "simplify2", "focuses");
    const focusDirs = readdirSync(focusesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(focusDirs).toHaveLength(2);

    const index = readFileSync(join(cwd, ".nanoboss", "simplify2", "index.json"), "utf8");
    expect(index).toContain("focus on session metadata");
    expect(index).toContain("focus on continuation persistence");
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

  runGitInFixture(cwd, ["init"]);
  runGitInFixture(cwd, ["config", "user.email", "simplify2-tests@example.com"]);
  runGitInFixture(cwd, ["config", "user.name", "Simplify2 Tests"]);
  runGitInFixture(cwd, ["add", "."]);
  runGitInFixture(cwd, ["commit", "-m", "Initial fixture"]);

  return cwd;
}

function findOnlyFocusDir(cwd: string): string {
  const focusesRoot = join(cwd, ".nanoboss", "simplify2", "focuses");
  const entries = readdirSync(focusesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(focusesRoot, entry.name));
  expect(entries).toHaveLength(1);
  const [focusDir] = entries;
  if (!focusDir) {
    throw new Error("Expected exactly one simplify2 focus directory");
  }
  return focusDir;
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
  options: {
    procedureResults?: unknown[];
    procedureCalls?: Array<{ name: string; prompt: string }>;
  } = {},
): ProcedureApi {
  let callCount = 0;
  let procedureCallCount = 0;
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "copilot",
    command: "bun",
    args: [],
    cwd,
  };
  const callAgent = (async (prompt: string) => {
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
    } as RunResult;
  }) as ProcedureApi["agent"]["run"];
  const callProcedure = (async (name: string, prompt: string) => {
    options.procedureCalls?.push({ name, prompt });
    const next = options.procedureResults?.shift();
    if (typeof next === "object" && next !== null && "cell" in next) {
      return next as RunResult;
    }

    if (next !== undefined) {
      procedureCallCount += 1;
      return {
        cell: {
          sessionId: "test-session",
          cellId: `procedure-${procedureCallCount}`,
        },
        data: next,
      } as RunResult;
    }

    if (name === "nanoboss/commit") {
      procedureCallCount += 1;
      return {
        cell: {
          sessionId: "test-session",
          cellId: `procedure-${procedureCallCount}`,
        },
        data: {
          checks: {
            passed: true,
          },
          commit: {
            cell: {
              sessionId: "test-session",
              cellId: `commit-${procedureCallCount}`,
            },
            path: "output.data",
          },
        },
        display: "commit sha=abc123 message=\"simplify2 slice\" clean=true",
        summary: "simplify2 slice commit",
      } as RunResult;
    }

    throw new Error(`Unexpected callProcedure ${name}`);
  }) as ProcedureApi["procedures"]["run"];
  const refs: ProcedureApi["state"]["refs"] = {
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
  const runs: ProcedureApi["state"]["runs"] = {
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
  const agent: ProcedureApi["agent"] = {
    run: callAgent,
    session() {
      return {
        run: callAgent,
      };
    },
  };

  return {
    cwd,
    sessionId: "test-session",
    agent,
    state: {
      runs,
      refs,
    },
    ui: {
      text() {},
      info() {},
      warning() {},
      error() {},
      status() {},
      card() {},
    },
    procedures: {
      run: callProcedure,
    },
    session: {
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
    },
    assertNotCancelled() {},
  };
}

function runGitInFixture(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  if (result.status === 0) {
    return;
  }

  throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n"));
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
