import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import typia from "typia";

import { expectData } from "../src/core/run-result.ts";
import {
  jsonType,
  type CommandContext,
  type KernelValue,
  type Procedure,
  type ProcedureResult,
} from "../src/core/types.ts";
import { summarizeText } from "../src/util/text.ts";

import { ensureGitLocalExclude, resolveGitRepoRoot } from "./autoresearch/git.ts";

type SimplifyMode = "explore" | "checkpoint" | "apply" | "reconcile" | "finished";
type ObservationKind =
  | "concept_candidate"
  | "invariant_candidate"
  | "boundary_candidate"
  | "exception_candidate"
  | "duplication"
  | "test_smell"
  | "architecture_drift"
  | "design_evolution_signal";
type HypothesisKind =
  | "merge_concepts"
  | "collapse_boundary"
  | "centralize_invariant"
  | "remove_exception"
  | "canonicalize_representation"
  | "simplify_tests"
  | "design_update";
type Confidence = "low" | "medium" | "high";
type Risk = "low" | "medium" | "high";
type CheckpointKind =
  | "concept_merge"
  | "canonical_representation"
  | "boundary_challenge"
  | "exception_legitimacy"
  | "design_update";
type TestSliceClass = "invariant" | "boundary_contract" | "smoke" | "regression";
type HumanDecisionKind =
  | "approve_hypothesis"
  | "reject_hypothesis"
  | "redirect"
  | "design_update"
  | "stop";

interface SimplifyEvidenceRef {
  kind: "file" | "test" | "doc" | "commit" | "journal";
  ref: string;
  note?: string;
}

interface SimplifyObservation {
  id: string;
  kind: ObservationKind;
  summary: string;
  evidence: SimplifyEvidenceRef[];
  confidence: Confidence;
}

interface SimplifyHypothesisExpectedDelta {
  conceptsReduced?: number;
  boundariesReduced?: number;
  exceptionsReduced?: number;
  duplicateRepresentationsReduced?: number;
  testRuntimeDelta?: "lower" | "neutral" | "higher";
}

interface SimplifyHypothesisDraft {
  id: string;
  title: string;
  kind: HypothesisKind;
  summary: string;
  rationale: string;
  evidence: SimplifyEvidenceRef[];
  expectedDelta: SimplifyHypothesisExpectedDelta;
  risk: Risk;
  needsHumanCheckpoint: boolean;
  checkpointReason?: string;
  implementationScope: string[];
  testImplications: string[];
}

interface SimplifyHypothesis extends SimplifyHypothesisDraft {
  score: number;
  rankingReason?: string;
}

interface SimplifyCheckpoint {
  hypothesisId: string;
  kind: CheckpointKind;
  question: string;
  options?: string[];
}

interface SimplifyQuestion {
  id: string;
  prompt: string;
  kind: "human_checkpoint" | "research_followup" | "validation_gap";
}

interface TestSliceSelection {
  testId: string;
  path: string;
  class: TestSliceClass;
  subsystems: string[];
  concepts: string[];
  invariants: string[];
  boundaries: string[];
  exceptions: string[];
  confidence: Confidence;
  reason: string;
}

interface ValidationSummary {
  status: "passed" | "failed" | "skipped";
  command?: string;
  selectedTests: string[];
  outputSummary: string;
  failureDetails?: string;
}

interface SimplifyHumanRedirect {
  scope?: string[];
  exclusions?: string[];
  goals?: string[];
  constraints?: string[];
  guidance?: string;
}

interface SimplifyDesignUpdate {
  updateKind: string;
  target: string;
  newStatus?: string;
  summary: string;
}

interface SimplifyHumanDecision {
  kind: HumanDecisionKind;
  reason: string;
  hypothesisId?: string;
  redirect?: SimplifyHumanRedirect;
  designUpdate?: SimplifyDesignUpdate;
}

interface SimplifyApplyResult {
  summary: string;
  touchedFiles: string[];
  conceptualChanges: string[];
  testChanges: string[];
  validationNotes: string[];
}

interface SimplifyAppliedSlice {
  hypothesisId: string;
  title: string;
  result: SimplifyApplyResult;
}

interface ArchitectureRefreshProposal {
  newObservations: SimplifyObservation[];
  staleItems: string[];
  suspectConceptMerges: string[];
  suspectBoundaryCollapses: string[];
  invariantCandidates: string[];
  designEvolutionSignals: string[];
}

interface ObservationBatch {
  observations: SimplifyObservation[];
}

interface HypothesisBatch {
  hypotheses: SimplifyHypothesisDraft[];
}

interface HypothesisRanking {
  hypothesisId: string;
  score: number;
  reason: string;
  needsHumanCheckpoint: boolean;
}

interface HypothesisRankingBatch {
  rankings: HypothesisRanking[];
}

interface ReconciliationResult {
  journalSummary: string;
  memorySummary: string;
  memoryUpdates: {
    concepts: string[];
    invariants: string[];
    boundaries: string[];
    exceptions: string[];
    staleItems: string[];
  };
  nextQuestions: string[];
  resolvedHypothesisIds: string[];
  followupRecommendations: string[];
}

interface Simplify2ArchitectureMemory {
  version: 1;
  updatedAt: string;
  focus: string;
  concepts: string[];
  invariants: string[];
  boundaries: string[];
  exceptions: string[];
  staleItems: string[];
  notes: string[];
}

interface Simplify2JournalEntry {
  id: string;
  timestamp: string;
  kind: "checkpoint" | "human_decision" | "reconciliation" | "run";
  summary: string;
  details: string[];
  hypothesisId?: string;
  validationStatus?: ValidationSummary["status"];
}

interface Simplify2Journal {
  version: 1;
  updatedAt: string;
  entries: Simplify2JournalEntry[];
}

interface Simplify2TestMap {
  version: 1;
  updatedAt: string;
  tests: TestSliceSelection[];
}

interface Simplify2State {
  version: 1;
  originalPrompt: string;
  iteration: number;
  maxIterations: number;
  mode: SimplifyMode;
  focus: {
    scope: string[];
    exclusions: string[];
    goals: string[];
    constraints: string[];
    guidance: string[];
  };
  artifacts: {
    repoRoot?: string;
    storageDir?: string;
    architectureMemoryPath?: string;
    journalPath?: string;
    testMapPath?: string;
  };
  memorySnapshot: {
    concepts: string[];
    invariants: string[];
    boundaries: string[];
    exceptions: string[];
    openHypothesisIds: string[];
    staleItems: string[];
  };
  notebook: {
    status: "active" | "awaiting_human" | "closed";
    observations: SimplifyObservation[];
    candidateHypotheses: SimplifyHypothesis[];
    openQuestions: SimplifyQuestion[];
    refreshNotes: string[];
    currentCheckpoint?: SimplifyCheckpoint;
    latestApply?: SimplifyAppliedSlice;
  };
  testContext: {
    changedSubsystems: string[];
    selectedSlice: TestSliceSelection[];
    lastValidation?: ValidationSummary;
  };
  history: {
    journalEntryIds: string[];
    appliedHypothesisIds: string[];
    rejectedHypothesisIds: string[];
    resolvedHypothesisIds: string[];
    decisions: string[];
  };
}

interface Simplify2Paths {
  repoRoot: string;
  storageDir: string;
  architectureMemoryPath: string;
  journalPath: string;
  testMapPath: string;
}

interface Simplify2ActionFinish {
  kind: "finish";
  reason: string;
}

interface Simplify2ActionPause {
  kind: "pause_for_human";
  checkpoint: SimplifyCheckpoint;
  question: string;
}

interface Simplify2ActionApply {
  kind: "apply_change";
  hypothesis: SimplifyHypothesis;
}

type Simplify2Action = Simplify2ActionFinish | Simplify2ActionPause | Simplify2ActionApply;

const SimplifyObservationType = jsonType<SimplifyObservation>(
  typia.json.schema<SimplifyObservation>(),
  typia.createValidate<SimplifyObservation>(),
);
const SimplifyHypothesisDraftType = jsonType<SimplifyHypothesisDraft>(
  typia.json.schema<SimplifyHypothesisDraft>(),
  typia.createValidate<SimplifyHypothesisDraft>(),
);
const SimplifyHypothesisType = jsonType<SimplifyHypothesis>(
  typia.json.schema<SimplifyHypothesis>(),
  typia.createValidate<SimplifyHypothesis>(),
);
const TestSliceSelectionType = jsonType<TestSliceSelection>(
  typia.json.schema<TestSliceSelection>(),
  typia.createValidate<TestSliceSelection>(),
);
const ValidationSummaryType = jsonType<ValidationSummary>(
  typia.json.schema<ValidationSummary>(),
  typia.createValidate<ValidationSummary>(),
);
const SimplifyHumanDecisionType = jsonType<SimplifyHumanDecision>(
  typia.json.schema<SimplifyHumanDecision>(),
  typia.createValidate<SimplifyHumanDecision>(),
);
const SimplifyApplyResultType = jsonType<SimplifyApplyResult>(
  typia.json.schema<SimplifyApplyResult>(),
  typia.createValidate<SimplifyApplyResult>(),
);
const ArchitectureRefreshProposalType = jsonType<ArchitectureRefreshProposal>(
  typia.json.schema<ArchitectureRefreshProposal>(),
  typia.createValidate<ArchitectureRefreshProposal>(),
);
const ObservationBatchType = jsonType<ObservationBatch>(
  typia.json.schema<ObservationBatch>(),
  typia.createValidate<ObservationBatch>(),
);
const HypothesisBatchType = jsonType<HypothesisBatch>(
  typia.json.schema<HypothesisBatch>(),
  typia.createValidate<HypothesisBatch>(),
);
const HypothesisRankingBatchType = jsonType<HypothesisRankingBatch>(
  typia.json.schema<HypothesisRankingBatch>(),
  typia.createValidate<HypothesisRankingBatch>(),
);
const ReconciliationResultType = jsonType<ReconciliationResult>(
  typia.json.schema<ReconciliationResult>(),
  typia.createValidate<ReconciliationResult>(),
);
const Simplify2StateType = jsonType<Simplify2State>(
  typia.json.schema<Simplify2State>(),
  typia.createValidate<Simplify2State>(),
);
const Simplify2ArchitectureMemoryType = jsonType<Simplify2ArchitectureMemory>(
  typia.json.schema<Simplify2ArchitectureMemory>(),
  typia.createValidate<Simplify2ArchitectureMemory>(),
);
const Simplify2JournalType = jsonType<Simplify2Journal>(
  typia.json.schema<Simplify2Journal>(),
  typia.createValidate<Simplify2Journal>(),
);
const Simplify2JournalEntryType = jsonType<Simplify2JournalEntry>(
  typia.json.schema<Simplify2JournalEntry>(),
  typia.createValidate<Simplify2JournalEntry>(),
);
const Simplify2TestMapType = jsonType<Simplify2TestMap>(
  typia.json.schema<Simplify2TestMap>(),
  typia.createValidate<Simplify2TestMap>(),
);

const DEFAULT_FOCUS = "simplify the current project";
const DEFAULT_MAX_ITERATIONS = 3;
const SIMPLIFY2_STORAGE_SUBDIR = [".nanoboss", "simplify2"] as const;
const SIMPLIFY2_LOCAL_EXCLUDE_PATTERN = "/.nanoboss/";
const SUGGESTED_REPLIES = [
  "approve it",
  "reject it",
  "focus on tests instead",
  "the boundary is real",
  "stop",
];
const TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "by",
  "current",
  "for",
  "from",
  "helper",
  "into",
  "layer",
  "mock",
  "none",
  "not",
  "one",
  "only",
  "project",
  "repo",
  "scope",
  "simplify",
  "slice",
  "src",
  "test",
  "tests",
  "the",
  "their",
  "this",
  "unit",
  "with",
]);

export default {
  name: "simplify2",
  description: "Model conceptual simplification with explicit checkpoints and a bounded multi-step loop",
  inputHint: "Optional focus or scope",
  executionMode: "harness",
  async execute(prompt, ctx) {
    let state = initializeState(prompt);

    ctx.print("Loading simplify2 artifacts...\n");
    state = loadArtifacts(state, ctx);
    state = await analyzeCurrentFocus(state, ctx);

    return continueFromAnalysis(state, ctx);
  },
  async resume(prompt, rawState, ctx) {
    let state = requireSimplify2State(rawState);

    ctx.print(`Interpreting simplify2 guidance for iteration ${state.iteration}...\n`);
    const decision = await interpretHumanReply(prompt, state, ctx);
    state = applyHumanDecision(state, decision);
    state = appendJournalForHumanDecision(state, decision);

    if (decision.kind === "stop") {
      state.mode = "finished";
      state.notebook.status = "closed";
      return buildFinishedResult(state, decision.reason);
    }

    if (decision.kind === "approve_hypothesis") {
      const hypothesis = findHypothesis(state, decision.hypothesisId);
      ctx.print(`Applying ${hypothesis.title}...\n`);
      state = await applySimplificationSlice(state, hypothesis, ctx);
      state = await validateAndReconcile(state, ctx);
      const completion = maybeFinishAfterApply(state);
      if (completion) {
        return completion;
      }
      state = resetNotebookForFreshAnalysis(state);
      state = await analyzeCurrentFocus(state, ctx);
      return continueFromAnalysis(state, ctx);
    }

    if (decision.kind === "design_update" && decision.designUpdate) {
      state = reviseArchitectureMemory(state, decision.designUpdate);
    }

    state = resetNotebookForFreshAnalysis(state);
    state = await analyzeCurrentFocus(state, ctx);

    return continueFromAnalysis(state, ctx);
  },
} satisfies Procedure;

function initializeState(prompt: string): Simplify2State {
  const focus = prompt.trim() || DEFAULT_FOCUS;
  return {
    version: 1,
    originalPrompt: focus,
    iteration: 1,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    mode: "explore",
    focus: {
      scope: [],
      exclusions: [],
      goals: [focus],
      constraints: [],
      guidance: [],
    },
    artifacts: {},
    memorySnapshot: {
      concepts: [],
      invariants: [],
      boundaries: [],
      exceptions: [],
      openHypothesisIds: [],
      staleItems: [],
    },
    notebook: {
      status: "active",
      observations: [],
      candidateHypotheses: [],
      openQuestions: [],
      refreshNotes: [],
    },
    testContext: {
      changedSubsystems: [],
      selectedSlice: [],
    },
    history: {
      journalEntryIds: [],
      appliedHypothesisIds: [],
      rejectedHypothesisIds: [],
      resolvedHypothesisIds: [],
      decisions: [],
    },
  };
}

function loadArtifacts(state: Simplify2State, ctx: CommandContext): Simplify2State {
  const paths = resolveSimplify2Paths(ctx.cwd);
  const memory = readOrInitializeArchitectureMemory(paths, state.originalPrompt);
  const journal = readOrInitializeJournal(paths);
  const testMap = refreshTestMap(paths);

  return {
    ...state,
    artifacts: {
      repoRoot: paths.repoRoot,
      storageDir: paths.storageDir,
      architectureMemoryPath: paths.architectureMemoryPath,
      journalPath: paths.journalPath,
      testMapPath: paths.testMapPath,
    },
    memorySnapshot: summarizeArchitectureMemory(memory),
    history: {
      ...state.history,
      journalEntryIds: journal.entries.map((entry) => entry.id),
    },
    testContext: {
      ...state.testContext,
      changedSubsystems: uniqueStrings(testMap.tests.flatMap((test) => test.subsystems)),
    },
  };
}

async function refreshArchitectureMemory(
  state: Simplify2State,
  ctx: CommandContext,
): Promise<Simplify2State> {
  state.mode = "explore";
  const proposalResult = await ctx.callAgent(
    buildArchitectureRefreshPrompt(state),
    ArchitectureRefreshProposalType,
    { stream: false },
  );
  const proposal = expectData(proposalResult, "Missing architecture refresh proposal");
  const syntheticObservations = [
    ...proposal.suspectConceptMerges.map((summary, index) =>
      createSyntheticObservation(`refresh-concept-${index}`, "concept_candidate", summary, "medium")),
    ...proposal.suspectBoundaryCollapses.map((summary, index) =>
      createSyntheticObservation(`refresh-boundary-${index}`, "boundary_candidate", summary, "medium")),
    ...proposal.invariantCandidates.map((summary, index) =>
      createSyntheticObservation(`refresh-invariant-${index}`, "invariant_candidate", summary, "medium")),
    ...proposal.designEvolutionSignals.map((summary, index) =>
      createSyntheticObservation(`refresh-evolution-${index}`, "design_evolution_signal", summary, "low")),
  ];

  return {
    ...state,
    memorySnapshot: {
      ...state.memorySnapshot,
      staleItems: uniqueStrings([...state.memorySnapshot.staleItems, ...proposal.staleItems]),
    },
    notebook: {
      ...state.notebook,
      observations: dedupeObservations([
        ...state.notebook.observations,
        ...proposal.newObservations,
        ...syntheticObservations,
      ]),
      refreshNotes: uniqueStrings([
        ...state.notebook.refreshNotes,
        ...proposal.staleItems.map((item) => `stale: ${item}`),
        ...proposal.designEvolutionSignals.map((item) => `design pressure: ${item}`),
      ]),
    },
  };
}

async function collectObservations(
  state: Simplify2State,
  ctx: CommandContext,
): Promise<Simplify2State> {
  const result = await ctx.callAgent(
    buildObservationPrompt(state),
    ObservationBatchType,
    { stream: false },
  );
  const batch = expectData(result, "Missing observation batch");
  return {
    ...state,
    notebook: {
      ...state.notebook,
      observations: dedupeObservations([...state.notebook.observations, ...batch.observations]),
    },
  };
}

async function generateAndRankHypotheses(
  state: Simplify2State,
  ctx: CommandContext,
): Promise<Simplify2State> {
  const hypothesisResult = await ctx.callAgent(
    buildHypothesisPrompt(state),
    HypothesisBatchType,
    { stream: false },
  );
  const hypothesisBatch = expectData(hypothesisResult, "Missing hypotheses");
  const rankingResult = await ctx.callAgent(
    buildHypothesisRankingPrompt(state, hypothesisBatch),
    HypothesisRankingBatchType,
    { stream: false },
  );
  const rankings = expectData(rankingResult, "Missing hypothesis rankings");
  const candidateHypotheses = reconcileRankedHypotheses(hypothesisBatch, rankings, state);
  const currentCheckpoint = maybeCreateCheckpoint(candidateHypotheses);

  return {
    ...state,
    mode: currentCheckpoint ? "checkpoint" : "explore",
    memorySnapshot: {
      ...state.memorySnapshot,
      openHypothesisIds: candidateHypotheses.map((hypothesis) => hypothesis.id),
    },
    notebook: {
      ...state.notebook,
      candidateHypotheses,
      currentCheckpoint,
      openQuestions: currentCheckpoint
        ? [{
            id: `checkpoint-${currentCheckpoint.hypothesisId}`,
            prompt: currentCheckpoint.question,
            kind: "human_checkpoint",
          }]
        : [],
    },
  };
}

function decideNextAction(state: Simplify2State): Simplify2Action {
  const best = state.notebook.candidateHypotheses[0];
  if (!best) {
    return {
      kind: "finish",
      reason: "No worthwhile simplification hypothesis stood out after the current review cycle.",
    };
  }

  if (best.kind === "design_update" || best.needsHumanCheckpoint || best.risk !== "low") {
    const checkpoint = state.notebook.currentCheckpoint ?? buildCheckpoint(best);
    return {
      kind: "pause_for_human",
      checkpoint,
      question: checkpoint.question,
    };
  }

  return {
    kind: "apply_change",
    hypothesis: best,
  };
}

async function continueFromAnalysis(
  state: Simplify2State,
  ctx: CommandContext,
): Promise<ProcedureResult | string | void> {
  let current = state;

  for (;;) {
    const next = decideNextAction(current);
    if (next.kind === "finish") {
      current = markFinished(current);
      return buildFinishedResult(current, next.reason, buildLatestApplyLead(current));
    }

    if (next.kind === "pause_for_human") {
      current.mode = "checkpoint";
      current.notebook.status = "awaiting_human";
      current.notebook.currentCheckpoint = next.checkpoint;
      current = appendCheckpointJournal(current);
      return buildPausedResult(current, next.question);
    }

    ctx.print(`Applying ${next.hypothesis.title}...\n`);
    current = await applySimplificationSlice(current, next.hypothesis, ctx);
    current = await validateAndReconcile(current, ctx);

    const completion = maybeFinishAfterApply(current);
    if (completion) {
      return completion;
    }

    current = resetNotebookForFreshAnalysis(current);
    ctx.print(`Continuing simplify2 analysis for iteration ${current.iteration}...\n`);
    current = await analyzeCurrentFocus(current, ctx);
  }
}

async function applySimplificationSlice(
  state: Simplify2State,
  hypothesis: SimplifyHypothesis,
  ctx: CommandContext,
): Promise<Simplify2State> {
  state.mode = "apply";
  const selectedSlice = selectMinimalTrustedTestSlice(state, hypothesis);
  const applyResult = await ctx.callAgent(
    buildApplyPrompt(state, hypothesis, selectedSlice),
    SimplifyApplyResultType,
    { stream: false },
  );
  const applied = expectData(applyResult, "Missing simplify2 apply result");
  return {
    ...state,
    notebook: {
      ...state.notebook,
      latestApply: {
        hypothesisId: hypothesis.id,
        title: hypothesis.title,
        result: {
          ...applied,
          touchedFiles: normalizePaths(applied.touchedFiles),
          conceptualChanges: normalizeStrings(applied.conceptualChanges),
          testChanges: normalizeStrings(applied.testChanges),
          validationNotes: normalizeStrings(applied.validationNotes),
        },
      },
      currentCheckpoint: undefined,
      candidateHypotheses: state.notebook.candidateHypotheses.filter((candidate) => candidate.id !== hypothesis.id),
      openQuestions: [],
      status: "active",
    },
    history: {
      ...state.history,
      appliedHypothesisIds: uniqueStrings([...state.history.appliedHypothesisIds, hypothesis.id]),
    },
    testContext: {
      ...state.testContext,
      selectedSlice,
      changedSubsystems: inferRelevantSubsystems(hypothesis),
    },
  };
}

async function validateAndReconcile(
  state: Simplify2State,
  ctx: CommandContext,
): Promise<Simplify2State> {
  state.mode = "reconcile";
  const validation = runSelectedValidation(state);
  const reconciliationResult = await ctx.callAgent(
    buildReconciliationPrompt(state, validation),
    ReconciliationResultType,
    { stream: false },
  );
  const reconciliation = expectData(reconciliationResult, "Missing reconciliation result");
  state = applyReconciliationResult(state, reconciliation, validation);
  state = appendJournalAfterApply(state, reconciliation, validation);
  state.iteration += 1;
  return state;
}

function maybeFinishAfterApply(state: Simplify2State): ProcedureResult | undefined {
  const latestApply = state.notebook.latestApply;
  const validation = state.testContext.lastValidation;
  const lead = buildLatestApplyLead(state);

  if (validation?.status === "failed") {
    return buildFinishedResult(
      markFinished(state),
      latestApply
        ? `Validation failed after applying ${latestApply.title}.`
        : "Validation failed after the applied simplification slice.",
      lead,
    );
  }

  if (state.history.appliedHypothesisIds.length >= state.maxIterations) {
    return buildFinishedResult(
      markFinished(state),
      latestApply
        ? `Reached simplify2 iteration budget (${state.maxIterations}) after applying ${latestApply.title}.`
        : `Reached simplify2 iteration budget (${state.maxIterations}).`,
      lead,
    );
  }

  return undefined;
}

async function interpretHumanReply(
  prompt: string,
  state: Simplify2State,
  ctx: CommandContext,
): Promise<SimplifyHumanDecision> {
  const result = await ctx.callAgent(
    buildHumanDecisionPrompt(prompt, state),
    SimplifyHumanDecisionType,
    { stream: false },
  );
  const decision = expectData(result, "Missing simplify2 human decision");
  if (
    (decision.kind === "approve_hypothesis" || decision.kind === "reject_hypothesis")
    && !decision.hypothesisId
  ) {
    return {
      ...decision,
      hypothesisId: state.notebook.currentCheckpoint?.hypothesisId,
    };
  }

  return decision;
}

function applyHumanDecision(
  state: Simplify2State,
  decision: SimplifyHumanDecision,
): Simplify2State {
  const next = {
    ...state,
    notebook: {
      ...state.notebook,
      currentCheckpoint: undefined,
      openQuestions: [],
      status: decision.kind === "stop" ? "closed" : "active",
    },
    history: {
      ...state.history,
      decisions: uniqueStrings([...state.history.decisions, `${decision.kind}: ${decision.reason}`]),
      rejectedHypothesisIds: decision.kind === "reject_hypothesis" && decision.hypothesisId
        ? uniqueStrings([...state.history.rejectedHypothesisIds, decision.hypothesisId])
        : state.history.rejectedHypothesisIds,
    },
  };

  if (decision.kind === "redirect" && decision.redirect) {
    return {
      ...next,
      focus: {
        scope: decision.redirect.scope ? normalizeStrings(decision.redirect.scope) : next.focus.scope,
        exclusions: decision.redirect.exclusions ? normalizeStrings(decision.redirect.exclusions) : next.focus.exclusions,
        goals: decision.redirect.goals ? normalizeStrings(decision.redirect.goals) : next.focus.goals,
        constraints: decision.redirect.constraints
          ? normalizeStrings([...next.focus.constraints, ...decision.redirect.constraints])
          : next.focus.constraints,
        guidance: uniqueStrings([
          ...next.focus.guidance,
          decision.redirect.guidance ?? decision.reason,
        ]),
      },
    };
  }

  if (decision.kind === "design_update" && decision.designUpdate) {
    return {
      ...next,
      focus: {
        ...next.focus,
        constraints: uniqueStrings([...next.focus.constraints, decision.designUpdate.summary]),
        guidance: uniqueStrings([...next.focus.guidance, decision.reason]),
      },
    };
  }

  if (decision.kind === "reject_hypothesis") {
    return {
      ...next,
      focus: {
        ...next.focus,
        guidance: uniqueStrings([...next.focus.guidance, decision.reason]),
      },
    };
  }

  return next;
}

function reviseArchitectureMemory(
  state: Simplify2State,
  designUpdate: SimplifyDesignUpdate,
): Simplify2State {
  const memoryPath = requireArtifactPath(state.artifacts.architectureMemoryPath, "architecture memory");
  const memory = readJsonFile(memoryPath, Simplify2ArchitectureMemoryType, createDefaultArchitectureMemory(state.originalPrompt));
  const nextMemory: Simplify2ArchitectureMemory = {
    ...memory,
    updatedAt: nowIso(),
    boundaries: designUpdate.updateKind.includes("boundary")
      ? uniqueStrings([...memory.boundaries, designUpdate.target])
      : memory.boundaries,
    concepts: designUpdate.updateKind.includes("concept")
      ? uniqueStrings([...memory.concepts, designUpdate.target])
      : memory.concepts,
    notes: uniqueStrings([
      ...memory.notes,
      `${designUpdate.updateKind}: ${designUpdate.summary}`,
      designUpdate.newStatus ? `status=${designUpdate.newStatus}` : "",
    ]),
  };
  writeJsonFile(memoryPath, nextMemory);
  return {
    ...state,
    memorySnapshot: summarizeArchitectureMemory(nextMemory),
  };
}

function applyReconciliationResult(
  state: Simplify2State,
  reconciliation: ReconciliationResult,
  validation: ValidationSummary,
): Simplify2State {
  const memoryPath = requireArtifactPath(state.artifacts.architectureMemoryPath, "architecture memory");
  const memory = readJsonFile(memoryPath, Simplify2ArchitectureMemoryType, createDefaultArchitectureMemory(state.originalPrompt));
  const nextMemory: Simplify2ArchitectureMemory = {
    ...memory,
    updatedAt: nowIso(),
    concepts: uniqueStrings(reconciliation.memoryUpdates.concepts),
    invariants: uniqueStrings(reconciliation.memoryUpdates.invariants),
    boundaries: uniqueStrings(reconciliation.memoryUpdates.boundaries),
    exceptions: uniqueStrings(reconciliation.memoryUpdates.exceptions),
    staleItems: uniqueStrings(reconciliation.memoryUpdates.staleItems),
    notes: uniqueStrings([
      ...memory.notes,
      reconciliation.memorySummary,
      validation.outputSummary,
      ...reconciliation.followupRecommendations,
    ]),
  };
  writeJsonFile(memoryPath, nextMemory);

  const testMapPath = requireArtifactPath(state.artifacts.testMapPath, "test map");
  const repoRoot = requireArtifactPath(state.artifacts.repoRoot, "repo root");
  writeJsonFile(testMapPath, buildTestMap(repoRoot));

  return {
    ...state,
    mode: "explore",
    memorySnapshot: summarizeArchitectureMemory(nextMemory),
    notebook: {
      ...state.notebook,
      candidateHypotheses: [],
      currentCheckpoint: undefined,
      openQuestions: reconciliation.nextQuestions.map((prompt, index) => ({
        id: `followup-${index + 1}`,
        prompt,
        kind: "research_followup",
      })),
    },
    testContext: {
      ...state.testContext,
      lastValidation: validation,
    },
    history: {
      ...state.history,
      resolvedHypothesisIds: uniqueStrings([
        ...state.history.resolvedHypothesisIds,
        ...normalizeStrings(reconciliation.resolvedHypothesisIds),
      ]),
    },
  };
}

function appendCheckpointJournal(state: Simplify2State): Simplify2State {
  const checkpoint = state.notebook.currentCheckpoint;
  if (!checkpoint) {
    return state;
  }

  const entry = createJournalEntry({
    kind: "checkpoint",
    summary: `Paused on ${checkpoint.kind}`,
    details: [
      checkpoint.question,
      `hypothesis=${checkpoint.hypothesisId}`,
    ],
    hypothesisId: checkpoint.hypothesisId,
  });
  return appendJournalEntry(state, entry);
}

function appendJournalForHumanDecision(
  state: Simplify2State,
  decision: SimplifyHumanDecision,
): Simplify2State {
  const entry = createJournalEntry({
    kind: "human_decision",
    summary: `Human decision: ${decision.kind}`,
    details: [
      decision.reason,
      decision.hypothesisId ? `hypothesis=${decision.hypothesisId}` : "",
      decision.redirect?.guidance ?? "",
      decision.designUpdate?.summary ?? "",
    ],
    hypothesisId: decision.hypothesisId,
  });
  return appendJournalEntry(state, entry);
}

function appendJournalAfterApply(
  state: Simplify2State,
  reconciliation: ReconciliationResult,
  validation: ValidationSummary,
): Simplify2State {
  const latestApply = state.notebook.latestApply;
  const entry = createJournalEntry({
    kind: "reconciliation",
    summary: reconciliation.journalSummary,
    details: [
      latestApply?.result.summary ?? "",
      reconciliation.memorySummary,
      validation.outputSummary,
      ...reconciliation.followupRecommendations,
    ],
    hypothesisId: latestApply?.hypothesisId,
    validationStatus: validation.status,
  });
  return appendJournalEntry(state, entry);
}

function appendJournalEntry(
  state: Simplify2State,
  entry: Simplify2JournalEntry,
): Simplify2State {
  const journalPath = requireArtifactPath(state.artifacts.journalPath, "journal");
  const journal = readJsonFile(journalPath, Simplify2JournalType, createDefaultJournal());
  const nextJournal: Simplify2Journal = {
    ...journal,
    updatedAt: nowIso(),
    entries: [...journal.entries, entry],
  };
  writeJsonFile(journalPath, nextJournal);
  return {
    ...state,
    history: {
      ...state.history,
      journalEntryIds: [...state.history.journalEntryIds, entry.id],
    },
  };
}

function buildPausedResult(
  state: Simplify2State,
  question: string,
): ProcedureResult {
  const best = state.notebook.candidateHypotheses[0];
  return {
    display: [
      buildLatestApplyLead(state),
      renderHypothesis(best, state.iteration),
      question,
      renderCheckpointOptions(state.notebook.currentCheckpoint),
    ].filter(Boolean).join("\n\n") + "\n",
    summary: best
      ? `simplify2: paused on ${best.title}`
      : "simplify2: paused for checkpoint",
    memory: best
      ? `Simplify2 paused on "${best.title}".`
      : "Simplify2 paused for a checkpoint.",
    pause: {
      question,
      state,
      inputHint: "Reply with approve, reject, redirect the search, revise the design, or stop",
      suggestedReplies: SUGGESTED_REPLIES,
    },
  };
}

function buildFinishedResult(
  state: Simplify2State,
  reason: string,
  lead?: string,
): ProcedureResult {
  const latestApply = state.notebook.latestApply;
  const validation = state.testContext.lastValidation;
  const appliedCount = state.history.appliedHypothesisIds.length;
  const rejectedCount = state.history.rejectedHypothesisIds.length;
  return {
    data: {
      focus: state.originalPrompt,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      appliedCount,
      rejectedCount,
      validationStatus: validation?.status,
      latestHypothesis: latestApply?.title,
    },
    display: [
      lead,
      "Simplify2 is done for now.",
      `Reason: ${reason}`,
      `Applied hypotheses: ${appliedCount}.`,
      `Rejected hypotheses: ${rejectedCount}.`,
      renderValidationLine(validation),
    ].filter(Boolean).join("\n") + "\n",
    summary: `simplify2: finished after ${state.iteration} iteration${state.iteration === 1 ? "" : "s"}`,
    memory: `Simplify2 finished after ${state.iteration} iteration${state.iteration === 1 ? "" : "s"}.`,
  };
}

function resetNotebookForFreshAnalysis(state: Simplify2State): Simplify2State {
  return {
    ...state,
    mode: "explore",
    notebook: {
      ...state.notebook,
      observations: [],
      candidateHypotheses: [],
      openQuestions: [],
      currentCheckpoint: undefined,
      refreshNotes: [],
    },
    memorySnapshot: {
      ...state.memorySnapshot,
      openHypothesisIds: [],
    },
    testContext: {
      ...state.testContext,
      selectedSlice: [],
    },
  };
}

function markFinished(state: Simplify2State): Simplify2State {
  return {
    ...state,
    mode: "finished",
    notebook: {
      ...state.notebook,
      status: "closed",
    },
  };
}

function findHypothesis(state: Simplify2State, hypothesisId?: string): SimplifyHypothesis {
  const resolvedId = hypothesisId ?? state.notebook.currentCheckpoint?.hypothesisId;
  const hypothesis = state.notebook.candidateHypotheses.find((candidate) => candidate.id === resolvedId);
  if (!hypothesis) {
    throw new Error(`Could not find simplify2 hypothesis "${resolvedId ?? "unknown"}".`);
  }
  return hypothesis;
}

function selectMinimalTrustedTestSlice(
  state: Simplify2State,
  hypothesis: SimplifyHypothesis,
): TestSliceSelection[] {
  const testMapPath = requireArtifactPath(state.artifacts.testMapPath, "test map");
  const testMap = readJsonFile(testMapPath, Simplify2TestMapType, createDefaultTestMap());
  const relevantTokens = new Set([
    ...extractTokens(hypothesis.title),
    ...extractTokens(hypothesis.summary),
    ...hypothesis.implementationScope.flatMap((path) => extractTokens(path)),
  ]);
  const implementationScope = new Set(hypothesis.implementationScope.map((path) => normalizePath(path)));
  const scored = testMap.tests
    .map((test) => ({
      test,
      score: scoreTestSelection(test, relevantTokens, implementationScope, hypothesis.kind),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.test.path.localeCompare(right.test.path));

  return scored.slice(0, 6).map((entry) => entry.test);
}

function scoreTestSelection(
  test: TestSliceSelection,
  relevantTokens: Set<string>,
  implementationScope: Set<string>,
  hypothesisKind: HypothesisKind,
): number {
  let score = 0;
  if (implementationScope.has(normalizePath(test.path))) {
    score += 200;
  }

  const testTokens = new Set(extractTokens(test.path));
  for (const token of relevantTokens) {
    if (testTokens.has(token)) {
      score += 12;
    }
  }

  if (hypothesisKind === "collapse_boundary" && test.class === "boundary_contract") {
    score += 18;
  }
  if (hypothesisKind === "canonicalize_representation" && test.class === "invariant") {
    score += 18;
  }
  if (test.class === "smoke") {
    score += 4;
  }

  return score;
}

function runSelectedValidation(state: Simplify2State): ValidationSummary {
  const repoRoot = requireArtifactPath(state.artifacts.repoRoot, "repo root");
  const selectedTests = normalizePaths(state.testContext.selectedSlice.map((test) => test.path))
    .filter((path) => existsSync(join(repoRoot, path)));

  if (selectedTests.length === 0) {
    return {
      status: "skipped",
      selectedTests: [],
      outputSummary: "Validation skipped because no trusted test slice matched the selected simplification scope.",
    };
  }

  const args = ["test", ...selectedTests];
  const result = spawnSync("bun", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`.trim();
  const outputSummary = summarizeText(output, 240) || `bun ${args.join(" ")} finished with status ${result.status ?? 1}`;

  return {
    status: result.status === 0 ? "passed" : "failed",
    command: `bun ${args.join(" ")}`,
    selectedTests,
    outputSummary,
    ...(result.status === 0 ? {} : { failureDetails: summarizeText(output, 600) }),
  };
}

function resolveSimplify2Paths(cwd: string): Simplify2Paths {
  const repoRoot = resolveRepoRootOrCwd(cwd);
  try {
    ensureGitLocalExclude(repoRoot, SIMPLIFY2_LOCAL_EXCLUDE_PATTERN);
  } catch {
    // The repo-local exclude is best-effort when git metadata is unavailable.
  }

  const storageDir = join(repoRoot, ...SIMPLIFY2_STORAGE_SUBDIR);
  return {
    repoRoot,
    storageDir,
    architectureMemoryPath: join(storageDir, "architecture-memory.json"),
    journalPath: join(storageDir, "journal.json"),
    testMapPath: join(storageDir, "test-map.json"),
  };
}

function resolveRepoRootOrCwd(cwd: string): string {
  try {
    return resolveGitRepoRoot(cwd);
  } catch {
    return resolve(cwd);
  }
}

function readOrInitializeArchitectureMemory(
  paths: Simplify2Paths,
  focus: string,
): Simplify2ArchitectureMemory {
  const fallback = createDefaultArchitectureMemory(focus);
  const memory = readJsonFile(paths.architectureMemoryPath, Simplify2ArchitectureMemoryType, fallback);
  if (!existsSync(paths.architectureMemoryPath)) {
    writeJsonFile(paths.architectureMemoryPath, memory);
  }
  return memory;
}

function readOrInitializeJournal(paths: Simplify2Paths): Simplify2Journal {
  const fallback = createDefaultJournal();
  const journal = readJsonFile(paths.journalPath, Simplify2JournalType, fallback);
  if (!existsSync(paths.journalPath)) {
    writeJsonFile(paths.journalPath, journal);
  }
  return journal;
}

function refreshTestMap(paths: Simplify2Paths): Simplify2TestMap {
  const testMap = buildTestMap(paths.repoRoot);
  writeJsonFile(paths.testMapPath, testMap);
  return testMap;
}

function buildTestMap(repoRoot: string): Simplify2TestMap {
  const testsRoot = join(repoRoot, "tests");
  const paths = existsSync(testsRoot) ? listFilesRecursive(testsRoot) : [];
  const tests = paths
    .filter((path) => path.endsWith(".test.ts") || path.endsWith(".test.tsx") || path.endsWith(".test.js"))
    .map((absolutePath) => toTestSelection(repoRoot, absolutePath))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: 1,
    updatedAt: nowIso(),
    tests,
  };
}

function toTestSelection(repoRoot: string, absolutePath: string): TestSliceSelection {
  const path = normalizePath(relative(repoRoot, absolutePath));
  const tokens = extractTokens(path);
  const className = classifyTest(path);
  const subsystems = uniqueStrings(tokens.filter((token) => token !== "unit" && token !== "e2e").slice(0, 5));
  return {
    testId: path,
    path,
    class: className,
    subsystems,
    concepts: subsystems,
    invariants: className === "invariant" ? subsystems.slice(0, 3) : [],
    boundaries: className === "boundary_contract" || className === "smoke" ? subsystems.slice(0, 3) : [],
    exceptions: [],
    confidence: className === "smoke" ? "medium" : "high",
    reason: `Derived from ${path}`,
  };
}

function classifyTest(path: string): TestSliceClass {
  if (path.includes("/e2e/")) {
    return "smoke";
  }

  if (
    path.includes("server")
    || path.includes("service")
    || path.includes("controller")
    || path.includes("mcp")
    || path.includes("dispatch")
  ) {
    return "boundary_contract";
  }

  return "invariant";
}

function buildArchitectureRefreshPrompt(state: Simplify2State): string {
  const journal = readJsonFile(
    requireArtifactPath(state.artifacts.journalPath, "journal"),
    Simplify2JournalType,
    createDefaultJournal(),
  );
  const testMap = readJsonFile(
    requireArtifactPath(state.artifacts.testMapPath, "test map"),
    Simplify2TestMapType,
    createDefaultTestMap(),
  );
  return [
    "You are helping maintain durable architecture memory for the current repository.",
    "Your task is not to propose code edits yet.",
    "Return JSON only with these fields:",
    "- `newObservations`",
    "- `staleItems`",
    "- `suspectConceptMerges`",
    "- `suspectBoundaryCollapses`",
    "- `invariantCandidates`",
    "- `designEvolutionSignals`",
    "Prefer semantic observations over file-level commentary.",
    "",
    `Current focus: ${renderFocusSummary(state)}`,
    `Architecture memory summary:\n${renderMemorySummary(state.memorySnapshot)}`,
    `Recent journal highlights:\n${renderJournalSummary(journal.entries)}`,
    `Current inferred test map:\n${renderTestMapSummary(testMap)}`,
  ].join("\n");
}

function buildObservationPrompt(state: Simplify2State): string {
  return [
    "You are scanning the repository for conceptual simplification observations.",
    "Return JSON only with one field: `observations`.",
    "Each observation kind must be one of:",
    "- `concept_candidate`",
    "- `invariant_candidate`",
    "- `boundary_candidate`",
    "- `exception_candidate`",
    "- `duplication`",
    "- `test_smell`",
    "- `architecture_drift`",
    "- `design_evolution_signal`",
    "Do not propose code patches yet.",
    "",
    `Current focus: ${renderFocusSummary(state)}`,
    `Architecture memory summary:\n${renderMemorySummary(state.memorySnapshot)}`,
    `Notebook context:\n${renderObservationSummary(state.notebook.observations)}`,
  ].join("\n");
}

function buildHypothesisPrompt(state: Simplify2State): string {
  const testMap = readJsonFile(
    requireArtifactPath(state.artifacts.testMapPath, "test map"),
    Simplify2TestMapType,
    createDefaultTestMap(),
  );
  return [
    "You are generating simplification hypotheses from structured observations.",
    "Return JSON only with one field: `hypotheses`.",
    "Generate 3 to 7 hypotheses when possible.",
    "Prefer reducing accidental concepts, fake boundaries, exceptions, duplicate representations, or test duplication.",
    "Avoid broad rewrites and new wrapper layers.",
    "",
    `Overall simplify focus: ${renderFocusSummary(state)}`,
    `Architecture memory summary:\n${renderMemorySummary(state.memorySnapshot)}`,
    `Current notebook observations:\n${renderObservationSummary(state.notebook.observations)}`,
    `Current inferred test map:\n${renderTestMapSummary(testMap)}`,
  ].join("\n");
}

function buildHypothesisRankingPrompt(
  state: Simplify2State,
  hypotheses: HypothesisBatch,
): string {
  return [
    "You are ranking simplification hypotheses for implementation order.",
    "Return JSON only with one field: `rankings`.",
    "Score each hypothesis on conceptual reduction, confidence, implementation risk, test hardening value, and expected effect on future simplification.",
    "Prefer small-to-medium changes with high conceptual delta.",
    "",
    `Overall simplify focus: ${renderFocusSummary(state)}`,
    `Hypotheses:\n${JSON.stringify(hypotheses.hypotheses, null, 2)}`,
  ].join("\n");
}

function buildHumanDecisionPrompt(
  prompt: string,
  state: Simplify2State,
): string {
  const best = state.notebook.candidateHypotheses[0];
  return [
    "Interpret the user's reply about the current simplify checkpoint.",
    "Return JSON only.",
    "Allowed decision kinds:",
    "- `approve_hypothesis`",
    "- `reject_hypothesis`",
    "- `redirect`",
    "- `design_update`",
    "- `stop`",
    "",
    `Current checkpoint:\n${renderCheckpoint(state.notebook.currentCheckpoint)}`,
    `Current best hypothesis:\n${renderHypothesisSummary(best)}`,
    `Current architecture memory:\n${renderMemorySummary(state.memorySnapshot)}`,
    `User reply: ${prompt.trim() || "(empty)"}`,
  ].join("\n");
}

function buildApplyPrompt(
  state: Simplify2State,
  hypothesis: SimplifyHypothesis,
  selectedSlice: TestSliceSelection[],
): string {
  return [
    "Apply one simplification slice directly in the repository.",
    "You must follow these rules:",
    "1. Prefer deleting, inlining, collapsing, or canonicalizing over introducing new abstraction layers.",
    "2. Preserve behavior by strengthening semantic tests, not by preserving accidental structure.",
    "3. Remove tests that only preserve deleted surface complexity.",
    "4. Add or strengthen tests for surviving invariants and real boundaries.",
    "5. Keep the change coherent and limited to the implementation scope.",
    "6. Validate with the provided minimal trusted test slice first.",
    "7. Return JSON only with `summary`, `touchedFiles`, `conceptualChanges`, `testChanges`, and `validationNotes`.",
    "",
    `Overall simplify focus: ${renderFocusSummary(state)}`,
    `Current architecture memory summary:\n${renderMemorySummary(state.memorySnapshot)}`,
    `Selected hypothesis:\n${JSON.stringify(hypothesis, null, 2)}`,
    `Selected minimal trusted test slice:\n${JSON.stringify(selectedSlice, null, 2)}`,
  ].join("\n");
}

function buildReconciliationPrompt(
  state: Simplify2State,
  validation: ValidationSummary,
): string {
  return [
    "Summarize the conceptual result of the applied simplification and propose updates to architecture memory and the journal.",
    "Return JSON only with `journalSummary`, `memorySummary`, `memoryUpdates`, `nextQuestions`, `resolvedHypothesisIds`, and `followupRecommendations`.",
    "",
    `Overall simplify focus: ${renderFocusSummary(state)}`,
    `Current architecture memory summary:\n${renderMemorySummary(state.memorySnapshot)}`,
    `Applied simplification:\n${JSON.stringify(state.notebook.latestApply, null, 2)}`,
    `Selected minimal trusted test slice:\n${JSON.stringify(state.testContext.selectedSlice, null, 2)}`,
    `Validation result:\n${JSON.stringify(validation, null, 2)}`,
  ].join("\n");
}

function reconcileRankedHypotheses(
  hypotheses: HypothesisBatch,
  rankings: HypothesisRankingBatch,
  state: Simplify2State,
): SimplifyHypothesis[] {
  const rankingById = new Map(rankings.rankings.map((ranking) => [ranking.hypothesisId, ranking]));
  return hypotheses.hypotheses
    .filter((hypothesis) =>
      !state.history.appliedHypothesisIds.includes(hypothesis.id)
      && !state.history.rejectedHypothesisIds.includes(hypothesis.id)
      && !state.history.resolvedHypothesisIds.includes(hypothesis.id))
    .map((hypothesis) => {
      const ranking = rankingById.get(hypothesis.id);
      const score = ranking?.score;
      return {
        ...hypothesis,
        score: typeof score === "number" && Number.isFinite(score) ? score : 0,
        needsHumanCheckpoint: ranking?.needsHumanCheckpoint ?? hypothesis.needsHumanCheckpoint,
        ...(ranking?.reason ? { rankingReason: ranking.reason } : {}),
      };
    })
    .filter((hypothesis) => SimplifyHypothesisType.validate(hypothesis))
    .sort((left, right) =>
      right.score - left.score
      || compareRisk(left.risk, right.risk)
      || left.title.localeCompare(right.title));
}

async function analyzeCurrentFocus(
  state: Simplify2State,
  ctx: CommandContext,
): Promise<Simplify2State> {
  ctx.print("Refreshing architecture memory for the current focus...\n");
  state = await refreshArchitectureMemory(state, ctx);

  ctx.print("Collecting conceptual simplification observations...\n");
  state = await collectObservations(state, ctx);

  ctx.print("Generating and ranking simplification hypotheses...\n");
  return await generateAndRankHypotheses(state, ctx);
}

function buildLatestApplyLead(state: Simplify2State): string | undefined {
  const latestApply = state.notebook.latestApply;
  if (!latestApply) {
    return undefined;
  }

  return [
    `Applied: ${latestApply.title}.`,
    latestApply.result.summary.trim(),
    renderTouchedFiles(latestApply.result.touchedFiles),
    renderValidationLine(state.testContext.lastValidation),
  ].filter(Boolean).join("\n");
}

function maybeCreateCheckpoint(hypotheses: SimplifyHypothesis[]): SimplifyCheckpoint | undefined {
  const best = hypotheses[0];
  if (!best || (!best.needsHumanCheckpoint && best.risk === "low" && best.kind !== "design_update")) {
    return undefined;
  }
  return buildCheckpoint(best);
}

function buildCheckpoint(hypothesis: SimplifyHypothesis): SimplifyCheckpoint {
  return {
    hypothesisId: hypothesis.id,
    kind: checkpointKindForHypothesis(hypothesis),
    question: buildCheckpointQuestion(hypothesis),
    options: checkpointOptionsForHypothesis(hypothesis),
  };
}

function checkpointKindForHypothesis(hypothesis: SimplifyHypothesis): CheckpointKind {
  switch (hypothesis.kind) {
    case "merge_concepts":
      return "concept_merge";
    case "collapse_boundary":
      return "boundary_challenge";
    case "remove_exception":
      return "exception_legitimacy";
    case "canonicalize_representation":
    case "simplify_tests":
      return "canonical_representation";
    case "design_update":
      return "design_update";
    case "centralize_invariant":
      return "canonical_representation";
  }
}

function buildCheckpointQuestion(hypothesis: SimplifyHypothesis): string {
  return [
    `Simplify2 wants to act on "${hypothesis.title}".`,
    hypothesis.checkpointReason
      ? `Checkpoint reason: ${hypothesis.checkpointReason}`
      : `Risk: ${hypothesis.risk}.`,
    "Should I approve this slice, reject it, redirect the search, revise the intended design, or stop?",
  ].join(" ");
}

function checkpointOptionsForHypothesis(hypothesis: SimplifyHypothesis): string[] {
  const options = ["approve it", "reject it", "stop"];
  if (hypothesis.kind === "design_update" || hypothesis.kind === "collapse_boundary") {
    options.splice(2, 0, "the boundary is real");
  }
  options.splice(2, 0, "focus on tests instead");
  return options;
}

function summarizeArchitectureMemory(memory: Simplify2ArchitectureMemory): Simplify2State["memorySnapshot"] {
  return {
    concepts: normalizeStrings(memory.concepts),
    invariants: normalizeStrings(memory.invariants),
    boundaries: normalizeStrings(memory.boundaries),
    exceptions: normalizeStrings(memory.exceptions),
    openHypothesisIds: [],
    staleItems: normalizeStrings(memory.staleItems),
  };
}

function createDefaultArchitectureMemory(focus: string): Simplify2ArchitectureMemory {
  return {
    version: 1,
    updatedAt: nowIso(),
    focus,
    concepts: [],
    invariants: [],
    boundaries: [],
    exceptions: [],
    staleItems: [],
    notes: [],
  };
}

function createDefaultJournal(): Simplify2Journal {
  return {
    version: 1,
    updatedAt: nowIso(),
    entries: [],
  };
}

function createDefaultTestMap(): Simplify2TestMap {
  return {
    version: 1,
    updatedAt: nowIso(),
    tests: [],
  };
}

function createJournalEntry(params: {
  kind: Simplify2JournalEntry["kind"];
  summary: string;
  details: string[];
  hypothesisId?: string;
  validationStatus?: ValidationSummary["status"];
}): Simplify2JournalEntry {
  const entry: Simplify2JournalEntry = {
    id: `journal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowIso(),
    kind: params.kind,
    summary: summarizeText(params.summary, 160),
    details: normalizeStrings(params.details),
  };
  if (params.hypothesisId) {
    entry.hypothesisId = params.hypothesisId;
  }
  if (params.validationStatus) {
    entry.validationStatus = params.validationStatus;
  }
  if (!Simplify2JournalEntryType.validate(entry)) {
    entry.details = [];
  }
  return entry;
}

function createSyntheticObservation(
  seed: string,
  kind: ObservationKind,
  summary: string,
  confidence: Confidence,
): SimplifyObservation {
  return {
    id: normalizeIdentifier(seed, kind, summary),
    kind,
    summary: summarizeText(summary, 240),
    evidence: [],
    confidence,
  };
}

function renderFocusSummary(state: Simplify2State): string {
  return [
    state.originalPrompt,
    state.focus.goals.length > 0 ? `goals=${state.focus.goals.join(" | ")}` : "",
    state.focus.constraints.length > 0 ? `constraints=${state.focus.constraints.join(" | ")}` : "",
    state.focus.guidance.length > 0 ? `guidance=${state.focus.guidance.join(" | ")}` : "",
  ].filter(Boolean).join("; ");
}

function renderMemorySummary(snapshot: Simplify2State["memorySnapshot"]): string {
  return [
    `Concepts: ${snapshot.concepts.join(", ") || "(none yet)"}`,
    `Invariants: ${snapshot.invariants.join(", ") || "(none yet)"}`,
    `Boundaries: ${snapshot.boundaries.join(", ") || "(none yet)"}`,
    `Exceptions: ${snapshot.exceptions.join(", ") || "(none yet)"}`,
    `Stale items: ${snapshot.staleItems.join(", ") || "(none)"}`,
  ].join("\n");
}

function renderJournalSummary(entries: Simplify2JournalEntry[]): string {
  const recent = entries.slice(-5);
  if (recent.length === 0) {
    return "- none";
  }

  return recent.map((entry) => `- ${entry.kind}: ${entry.summary}`).join("\n");
}

function renderObservationSummary(observations: SimplifyObservation[]): string {
  if (observations.length === 0) {
    return "- none";
  }

  return observations
    .slice(0, 10)
    .map((observation) => `- ${observation.kind}: ${observation.summary}`)
    .join("\n");
}

function renderTestMapSummary(testMap: Simplify2TestMap): string {
  const counts = new Map<TestSliceClass, number>();
  for (const test of testMap.tests) {
    counts.set(test.class, (counts.get(test.class) ?? 0) + 1);
  }
  return [
    `Total tests: ${testMap.tests.length}`,
    `Invariant: ${counts.get("invariant") ?? 0}`,
    `Boundary contract: ${counts.get("boundary_contract") ?? 0}`,
    `Smoke: ${counts.get("smoke") ?? 0}`,
    `Regression: ${counts.get("regression") ?? 0}`,
  ].join("\n");
}

function renderHypothesis(hypothesis: SimplifyHypothesis | undefined, iteration: number): string {
  if (!hypothesis) {
    return `Simplify2 iteration ${iteration}: no current hypothesis`;
  }

  return [
    `Simplify2 iteration ${iteration}: ${hypothesis.title}`,
    hypothesis.summary.trim(),
    `Kind: ${hypothesis.kind}; risk=${hypothesis.risk}; score=${hypothesis.score}`,
    `Why this helps: ${hypothesis.rationale.trim()}`,
    renderFiles(hypothesis.implementationScope),
  ].filter(Boolean).join("\n");
}

function renderHypothesisSummary(hypothesis: SimplifyHypothesis | undefined): string {
  if (!hypothesis) {
    return "(none)";
  }

  return [
    `title=${hypothesis.title}`,
    `kind=${hypothesis.kind}`,
    `risk=${hypothesis.risk}`,
    `score=${hypothesis.score}`,
    `summary=${hypothesis.summary}`,
    hypothesis.rankingReason ? `ranking=${hypothesis.rankingReason}` : "",
  ].filter(Boolean).join("\n");
}

function renderCheckpoint(checkpoint: SimplifyCheckpoint | undefined): string {
  if (!checkpoint) {
    return "(none)";
  }

  return [
    `kind=${checkpoint.kind}`,
    `hypothesisId=${checkpoint.hypothesisId}`,
    `question=${checkpoint.question}`,
    checkpoint.options?.length ? `options=${checkpoint.options.join(" | ")}` : "",
  ].filter(Boolean).join("\n");
}

function renderCheckpointOptions(checkpoint: SimplifyCheckpoint | undefined): string | undefined {
  if (!checkpoint?.options?.length) {
    return undefined;
  }
  return `Suggested replies: ${checkpoint.options.join(" | ")}`;
}

function renderFiles(files: string[]): string | undefined {
  const normalized = normalizePaths(files);
  return normalized.length > 0 ? `Scope: ${normalized.join(", ")}` : undefined;
}

function renderTouchedFiles(files: string[]): string | undefined {
  const normalized = normalizePaths(files);
  return normalized.length > 0 ? `Touched files: ${normalized.join(", ")}` : undefined;
}

function renderValidationLine(validation: ValidationSummary | undefined): string | undefined {
  if (!validation) {
    return undefined;
  }

  return `Validation: ${validation.status}. ${validation.outputSummary}`;
}

function compareRisk(left: Risk, right: Risk): number {
  const order: Risk[] = ["low", "medium", "high"];
  return order.indexOf(left) - order.indexOf(right);
}

function requireSimplify2State(value: KernelValue): Simplify2State {
  if (Simplify2StateType.validate(value)) {
    return value;
  }
  throw new Error("Invalid simplify2 continuation state.");
}

function requireArtifactPath(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new Error(`Simplify2 state is missing ${label}.`);
  }
  return value;
}

function readJsonFile<T>(
  path: string,
  descriptor: { validate: (input: unknown) => input is T },
  fallback: T,
): T {
  if (!existsSync(path)) {
    return fallback;
  }

  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!descriptor.validate(raw)) {
    return fallback;
  }
  return raw;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function listFilesRecursive(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const currentPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(currentPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(currentPath);
    }
  }
  return files;
}

function extractTokens(value: string): string[] {
  return uniqueStrings(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token)),
  );
}

function normalizeIdentifier(...values: string[]): string {
  const joined = values.join("-").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return joined || "item";
}

function normalizeStrings(values: string[]): string[] {
  return uniqueStrings(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function normalizePaths(values: string[]): string[] {
  return uniqueStrings(values.map((value) => normalizePath(value)).filter((value) => value.length > 0));
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function dedupeObservations(observations: SimplifyObservation[]): SimplifyObservation[] {
  const entries = new Map<string, SimplifyObservation>();
  for (const observation of observations) {
    const key = `${observation.kind}\u0000${observation.summary.trim().toLowerCase()}`;
    if (entries.has(key)) {
      continue;
    }
    entries.set(key, {
      ...observation,
      id: observation.id.trim() || normalizeIdentifier(observation.kind, observation.summary),
      summary: summarizeText(observation.summary, 240),
      evidence: observation.evidence.filter((evidence) => evidence.ref.trim().length > 0),
    });
  }
  return [...entries.values()];
}

function inferRelevantSubsystems(hypothesis: SimplifyHypothesis): string[] {
  return uniqueStrings(hypothesis.implementationScope.flatMap((path) => extractTokens(dirname(path) === "." ? basename(path) : dirname(path))));
}

function nowIso(): string {
  return new Date().toISOString();
}

void SimplifyObservationType;
void SimplifyHypothesisDraftType;
void TestSliceSelectionType;
void ValidationSummaryType;
