import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import typia from "typia";

import { expectData } from "../src/core/run-result.ts";
import {
  jsonType,
  type ProcedureApi,
  type KernelValue,
  type Procedure,
  type ProcedureResult,
  type RunResult,
  type Simplify2CheckpointContinuationUi,
  type Simplify2FocusPickerContinuationUi,
} from "../src/core/types.ts";
import { formatErrorMessage } from "../src/core/error-format.ts";
import { computeRepoFingerprint } from "../src/core/repo-fingerprint.ts";
import { resolveRepoArtifactDir, writeJsonFileAtomicSync } from "../src/util/repo-artifacts.ts";
import { summarizeText } from "../src/util/text.ts";

import { ensureGitLocalExclude, getWorktreeStatus, resolveGitRepoRoot } from "./autoresearch/git.ts";

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
  canonicalId?: string;
  sourceHypothesisId?: string;
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
  sourceHypothesisId?: string;
  decision?: {
    kind: HypothesisKind;
    risk: Risk;
    summary: string;
    rationale: string;
    rankingReason?: string;
    checkpointReason?: string;
    expectedDelta: SimplifyHypothesisExpectedDelta;
    implementationScope: string[];
    testImplications: string[];
    evidence: SimplifyEvidenceRef[];
  };
  result: SimplifyApplyResult;
  commit?: SimplifyCommitStatus;
}

interface SimplifyCommitStatus {
  status: "created" | "failed";
  commitContext: string;
  summary: string;
  display: string;
}

interface NanobossCommitProcedureResult {
  checks: {
    passed: boolean;
  };
  commit?: KernelValue;
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

interface Simplify2ObservationCacheEntry {
  observation: SimplifyObservation;
  sourcePaths: string[];
  evidenceRefs: SimplifyEvidenceRef[];
  derivedFromArtifacts: string[];
  stale: boolean;
}

interface Simplify2ObservationCache {
  version: 1;
  updatedAt: string;
  focusHash: string;
  analysisFingerprint: string;
  observations: Simplify2ObservationCacheEntry[];
}

interface Simplify2OverlapSuppressionEntry {
  hypothesisId: string;
  titleTokens: string[];
  summaryTokens: string[];
  normalizedScopeTokens: string[];
  touchedFiles: string[];
  evidenceRefs: string[];
}

interface Simplify2AnalysisCache {
  version: 1;
  updatedAt: string;
  focusHash: string;
  analysisFingerprint: string;
  lastAppliedHypothesisId?: string;
  lastTouchedFiles: string[];
  reusableObservationIds: string[];
  staleObservationIds: string[];
  overlapSuppression: Simplify2OverlapSuppressionEntry[];
}

type Simplify2FocusStatus = "active" | "paused" | "finished" | "archived";

interface Simplify2FocusPendingContinuation {
  question: string;
  updatedAt: string;
}

interface Simplify2FocusIndexEntry {
  id: string;
  title: string;
  normalizedFocus: string;
  rawPrompt: string;
  createdAt: string;
  updatedAt: string;
  status: Simplify2FocusStatus;
  lastCheckpointQuestion?: string;
  lastCommitSummary?: string;
  lastTouchedFiles?: string[];
  pendingContinuation?: Simplify2FocusPendingContinuation;
}

interface Simplify2FocusIndex {
  version: 1;
  updatedAt: string;
  entries: Simplify2FocusIndexEntry[];
}

interface Simplify2FocusMetadata {
  version: 1;
  id: string;
  title: string;
  normalizedFocus: string;
  rawPrompt: string;
  createdAt: string;
  updatedAt: string;
  status: Simplify2FocusStatus;
  lastSummary?: string;
  lastCheckpointQuestion?: string;
  lastCommitSummary?: string;
  lastTouchedFiles: string[];
  pendingContinuation?: Simplify2FocusPendingContinuation;
}

interface Simplify2State {
  version: 2;
  originalPrompt: string;
  iteration: number;
  maxIterations: number;
  mode: SimplifyMode | "focus_picker";
  focusRef: {
    id?: string;
    title?: string;
    normalizedFocus?: string;
    status?: Simplify2FocusStatus;
  };
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
    indexPath?: string;
    focusesDir?: string;
    focusDir?: string;
    focusPath?: string;
    statePath?: string;
    architectureMemoryPath?: string;
    journalPath?: string;
    testMapPath?: string;
    observationsPath?: string;
    analysisCachePath?: string;
  };
  analysisCache: {
    focusHash: string;
    analysisFingerprint?: string;
    observationsLoaded: boolean;
    reusedObservationIds: string[];
    staleObservationIds: string[];
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
  picker?: {
    entries: Simplify2FocusIndexEntry[];
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
  indexPath: string;
  focusesDir: string;
  focusDir: string;
  focusPath: string;
  statePath: string;
  architectureMemoryPath: string;
  journalPath: string;
  testMapPath: string;
  observationsPath: string;
  analysisCachePath: string;
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
const Simplify2ObservationCacheEntryType = jsonType<Simplify2ObservationCacheEntry>(
  typia.json.schema<Simplify2ObservationCacheEntry>(),
  typia.createValidate<Simplify2ObservationCacheEntry>(),
);
const Simplify2ObservationCacheType = jsonType<Simplify2ObservationCache>(
  typia.json.schema<Simplify2ObservationCache>(),
  typia.createValidate<Simplify2ObservationCache>(),
);
const Simplify2AnalysisCacheType = jsonType<Simplify2AnalysisCache>(
  typia.json.schema<Simplify2AnalysisCache>(),
  typia.createValidate<Simplify2AnalysisCache>(),
);
const Simplify2FocusIndexEntryType = jsonType<Simplify2FocusIndexEntry>(
  typia.json.schema<Simplify2FocusIndexEntry>(),
  typia.createValidate<Simplify2FocusIndexEntry>(),
);
const Simplify2FocusIndexType = jsonType<Simplify2FocusIndex>(
  typia.json.schema<Simplify2FocusIndex>(),
  typia.createValidate<Simplify2FocusIndex>(),
);
const Simplify2FocusMetadataType = jsonType<Simplify2FocusMetadata>(
  typia.json.schema<Simplify2FocusMetadata>(),
  typia.createValidate<Simplify2FocusMetadata>(),
);

const DEFAULT_FOCUS_TITLE = "Imported legacy simplify2 focus";
const DEFAULT_MAX_ITERATIONS = 1;
const MAX_ALLOWED_ITERATIONS = 20;
const SIMPLIFY2_STORAGE_SUBDIR = [".nanoboss", "simplify2"] as const;
const SIMPLIFY2_FOCUSES_SUBDIR = "focuses";
const SIMPLIFY2_LOCAL_EXCLUDE_PATTERN = "/.nanoboss/";
const ANALYSIS_STALE_FULL_REFRESH_THRESHOLD = 0.4;
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
const HIGH_SENSITIVITY_ANALYSIS_PATH_PATTERNS = [
  /^src\/core\//,
  /^src\/mcp\//,
];
const SIMPLIFY2_FOCUS_PICKER_UI: Simplify2FocusPickerContinuationUi = {
  kind: "simplify2_focus_picker",
  title: "Simplify2 focuses",
  entries: [],
  actions: [
    { id: "continue", label: "Continue" },
    { id: "archive", label: "Archive" },
    { id: "new", label: "New Focus" },
    { id: "cancel", label: "Cancel" },
  ],
};
const SIMPLIFY2_CONTINUATION_UI: Simplify2CheckpointContinuationUi = {
  kind: "simplify2_checkpoint",
  title: "Simplify2 checkpoint",
  actions: [
    {
      id: "approve",
      label: "Continue",
      reply: "approve it",
      description: "Approve the current simplify2 slice and apply it now.",
    },
    {
      id: "stop",
      label: "Stop",
      reply: "stop",
      description: "Stop simplify2 without applying the paused slice.",
    },
    {
      id: "focus_tests",
      label: "Focus on Tests",
      reply: "focus on tests instead",
      description: "Redirect simplify2 toward test cleanup instead of this slice.",
    },
    {
      id: "other",
      label: "Something Else",
      description: "Type a custom continuation reply for simplify2.",
    },
  ],
};

export default {
  name: "simplify2",
  description: "Model conceptual simplification with explicit checkpoints and a bounded multi-step loop",
  inputHint: "Optional simplify focus; omit to choose a saved focus",
  executionMode: "harness",
  async execute(prompt, ctx) {
    const initial = prepareSimplify2Execution(prompt, ctx.cwd);
    if (!isSimplify2State(initial)) {
      return initial;
    }

    let state = initial;
    if (state.notebook.status === "awaiting_human" && state.notebook.currentCheckpoint) {
      return buildPausedResult(syncPersistedFocusState(state), state.notebook.currentCheckpoint.question);
    }

    const blocked = buildBlockedDirtyWorktreeStartResult(ctx.cwd);
    if (blocked) {
      return blocked;
    }

    ctx.ui.text("Loading simplify2 artifacts...\n");
    state = loadArtifacts(state, ctx);
    state = await analyzeCurrentFocus(state, ctx);

    return continueFromAnalysis(state, ctx);
  },
  async resume(prompt, rawState, ctx) {
    let state = requireSimplify2State(rawState);
    if (state.mode === "focus_picker") {
      return await resumeFocusPicker(prompt, state, ctx);
    }

    ctx.ui.text(`Interpreting simplify2 guidance for ${formatIterationProgress(state.iteration, state.maxIterations)}...\n`);
    const decision = await interpretHumanReply(prompt, state, ctx);

    if (decision.kind !== "stop") {
      const blocked = buildBlockedDirtyWorktreeResumeResult(state, ctx.cwd);
      if (blocked) {
        return blocked;
      }
    }

    state = applyHumanDecision(state, decision);
    state = appendJournalForHumanDecision(state, decision);

    if (decision.kind === "stop") {
      state.mode = "finished";
      state.notebook.status = "closed";
      return buildFinishedResult(state, decision.reason);
    }

    if (decision.kind === "approve_hypothesis") {
      const hypothesis = findHypothesis(state, decision.hypothesisId);
      ctx.ui.text(`Applying ${hypothesis.title}...\n`);
      state = await applySimplificationSlice(state, hypothesis, ctx);
      state = await validateAndReconcile(state, ctx);
      const completion = maybeFinishAfterApply(state);
      if (completion) {
        return completion;
      }
      state = await commitAppliedSlice(state, hypothesis, ctx);
      const postCommitCompletion = maybeFinishAfterCommit(state);
      if (postCommitCompletion) {
        return postCommitCompletion;
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

function isSimplify2State(value: Simplify2State | ProcedureResult): value is Simplify2State {
  return "notebook" in value;
}

function prepareSimplify2Execution(prompt: string, cwd: string): Simplify2State | ProcedureResult {
  const parsed = parseSimplify2Prompt(prompt);
  if (parsed.focus) {
    return openFocusState(parsed.focus, parsed.maxIterations, cwd);
  }

  const root = resolveSimplify2StorageRoot(cwd);
  const index = readOrInitializeFocusIndex(root);
  const entries = listVisibleFocusEntries(index);
  const [onlyEntry] = entries;
  if (entries.length === 1 && onlyEntry) {
    return openStoredFocus(onlyEntry, parsed.maxIterations, root);
  }

  return buildFocusPickerResult(root, entries, parsed.maxIterations);
}

async function resumeFocusPicker(
  prompt: string,
  state: Simplify2State,
  ctx: ProcedureApi,
): Promise<ProcedureResult | string | void> {
  const root = requireSimplify2StorageRoot(state);
  const reply = prompt.trim();
  const selection = interpretFocusPickerReply(reply, state.picker?.entries ?? []);

  if (selection.kind === "cancel") {
    return {
      display: "Simplify2 focus selection cancelled.\n",
      summary: "simplify2: focus picker cancelled",
      memory: "Simplify2 focus selection cancelled.",
    };
  }

  if (selection.kind === "invalid") {
    return buildFocusPickerResult(root, listVisibleFocusEntries(readOrInitializeFocusIndex(root)), state.maxIterations, selection.reason);
  }

  if (selection.kind === "archive") {
    archiveFocusEntry(root, selection.entry.id);
    return buildFocusPickerResult(
      root,
      listVisibleFocusEntries(readOrInitializeFocusIndex(root)),
      state.maxIterations,
      `Archived focus "${selection.entry.title}".`,
    );
  }

  const nextState = selection.kind === "new"
    ? openFocusState(selection.focus, state.maxIterations, root.repoRoot)
    : openStoredFocus(selection.entry, state.maxIterations, root);

  if (nextState.notebook.status === "awaiting_human" && nextState.notebook.currentCheckpoint) {
    return buildPausedResult(syncPersistedFocusState(nextState), nextState.notebook.currentCheckpoint.question);
  }

  const blocked = buildBlockedDirtyWorktreeStartResult(ctx.cwd);
  if (blocked) {
    return blocked;
  }

  ctx.ui.text("Loading simplify2 artifacts...\n");
  let loaded = loadArtifacts(nextState, ctx);
  loaded = await analyzeCurrentFocus(loaded, ctx);
  return continueFromAnalysis(loaded, ctx);
}

function openFocusState(focus: string, maxIterations: number, cwd: string): Simplify2State {
  const root = resolveSimplify2StorageRoot(cwd);
  const index = readOrInitializeFocusIndex(root);
  const normalizedFocus = normalizeFocusText(focus);
  const existing = index.entries.find((entry) => entry.normalizedFocus === normalizedFocus);
  if (existing) {
    return openStoredFocus(existing, maxIterations, root);
  }

  const createdAt = nowIso();
  const entry: Simplify2FocusIndexEntry = {
    id: createFocusId(normalizedFocus),
    title: summarizeText(focus.trim(), 80) || DEFAULT_FOCUS_TITLE,
    normalizedFocus,
    rawPrompt: focus.trim(),
    createdAt,
    updatedAt: createdAt,
    status: "active",
  };
  const nextIndex: Simplify2FocusIndex = {
    ...index,
    updatedAt: createdAt,
    entries: [...index.entries, entry],
  };
  writeJsonFile(root.indexPath, nextIndex);
  const paths = buildSimplify2Paths(root, entry.id);
  writeJsonFile(paths.focusPath, createDefaultFocusMetadata(entry));

  const state = attachFocusArtifacts(initializeState(entry.rawPrompt, maxIterations), paths, entry);
  return syncPersistedFocusState(state);
}

function openStoredFocus(
  entry: Simplify2FocusIndexEntry,
  maxIterations: number,
  root: ReturnType<typeof resolveSimplify2StorageRoot>,
): Simplify2State {
  const reopenedEntry = entry.status === "archived"
    ? {
        ...entry,
        status: "active" as const,
        updatedAt: nowIso(),
      }
    : entry;
  const paths = buildSimplify2Paths(root, reopenedEntry.id);
  const persisted = readPersistedFocusState(paths);
  const baseState: Simplify2State = persisted
    ? {
        ...persisted,
        maxIterations,
        mode: persisted.notebook.currentCheckpoint ? "checkpoint" : "explore",
        picker: undefined,
      }
    : initializeState(reopenedEntry.rawPrompt, maxIterations);
  const state = attachFocusArtifacts(baseState, paths, reopenedEntry);
  if (state.notebook.status !== "awaiting_human") {
    return syncPersistedFocusState(resetNotebookForFocusReuse(state));
  }
  return syncPersistedFocusState(state);
}

function buildFocusPickerResult(
  root: ReturnType<typeof resolveSimplify2StorageRoot>,
  entries: Simplify2FocusIndexEntry[],
  maxIterations: number,
  note?: string,
): ProcedureResult {
  const pickerEntries = sortFocusEntries(entries);
  const state: Simplify2State = {
    ...initializeState("", maxIterations),
    mode: "focus_picker",
    artifacts: {
      repoRoot: root.repoRoot,
      storageDir: root.storageDir,
      indexPath: root.indexPath,
      focusesDir: root.focusesDir,
    },
    picker: {
      entries: pickerEntries,
    },
  };
  const question = pickerEntries.length === 0
    ? "No saved simplify focuses. Reply with `new <focus>` or `stop`."
    : "Choose a simplify focus to continue, archive, or replace.";
  return {
    display: renderFocusPickerDisplay(pickerEntries, note),
    summary: "simplify2: choose focus",
    memory: "Simplify2 is waiting for a focus selection.",
    pause: {
      question,
      state,
      inputHint: "Reply with a number, `new <focus>`, `archive <number>`, or `stop`",
      suggestedReplies: pickerEntries.length === 0
        ? ["new session metadata cleanup", "stop"]
        : ["1", "archive 1", "new session metadata cleanup", "stop"],
      continuationUi: {
        ...SIMPLIFY2_FOCUS_PICKER_UI,
        entries: pickerEntries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          subtitle: entry.rawPrompt === entry.title ? undefined : entry.rawPrompt,
          status: entry.status,
          updatedAt: entry.updatedAt,
          lastSummary: entry.lastCheckpointQuestion ?? entry.lastCommitSummary,
        })),
      },
    },
  };
}

function renderFocusPickerDisplay(entries: Simplify2FocusIndexEntry[], note?: string): string {
  if (entries.length === 0) {
    return [
      note,
      "No saved simplify focuses.",
      "Reply with `new <focus>` to create one or `stop` to cancel.",
    ].filter(Boolean).join("\n") + "\n";
  }

  return [
    note,
    "Saved simplify focuses:",
    ...sortFocusEntries(entries).map((entry, index) =>
      `${index + 1}. ${entry.title} | ${entry.status} | updated ${entry.updatedAt}${entry.lastCheckpointQuestion ? ` | checkpoint: ${entry.lastCheckpointQuestion}` : ""}${entry.lastCommitSummary ? ` | last commit: ${entry.lastCommitSummary}` : ""}`),
    "",
    "Reply with a number to continue, `archive <number>` to archive, `new <focus>` to start a new focus, or `stop`.",
  ].filter(Boolean).join("\n") + "\n";
}

function resetNotebookForFocusReuse(state: Simplify2State): Simplify2State {
  const reset = resetNotebookForFreshAnalysis(state);
  return {
    ...reset,
    notebook: {
      ...reset.notebook,
      status: "active",
    },
  };
}

function attachFocusArtifacts(
  state: Simplify2State,
  paths: Simplify2Paths,
  entry: Simplify2FocusIndexEntry,
): Simplify2State {
  return {
    ...state,
    originalPrompt: entry.rawPrompt,
    maxIterations: state.maxIterations,
    focusRef: {
      id: entry.id,
      title: entry.title,
      normalizedFocus: entry.normalizedFocus,
      status: entry.status,
    },
    artifacts: {
      ...state.artifacts,
      repoRoot: paths.repoRoot,
      storageDir: paths.storageDir,
      indexPath: paths.indexPath,
      focusesDir: paths.focusesDir,
      focusDir: paths.focusDir,
      focusPath: paths.focusPath,
      statePath: paths.statePath,
      architectureMemoryPath: paths.architectureMemoryPath,
      journalPath: paths.journalPath,
      testMapPath: paths.testMapPath,
      observationsPath: paths.observationsPath,
      analysisCachePath: paths.analysisCachePath,
    },
  };
}

function initializeState(prompt: string, maxIterations = DEFAULT_MAX_ITERATIONS): Simplify2State {
  const focus = prompt.trim();
  return {
    version: 2,
    originalPrompt: focus,
    iteration: 1,
    maxIterations,
    focusRef: {},
    mode: "explore",
    focus: {
      scope: [],
      exclusions: [],
      goals: [focus],
      constraints: [],
      guidance: [],
    },
    artifacts: {},
    analysisCache: {
      focusHash: hashFocusPayload({
        originalPrompt: focus,
        scope: [],
        exclusions: [],
        goals: [focus],
        constraints: [],
        guidance: [],
      }),
      observationsLoaded: false,
      reusedObservationIds: [],
      staleObservationIds: [],
    },
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
    picker: undefined,
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

function parseSimplify2Prompt(
  prompt: string,
): { focus?: string; maxIterations: number } {
  const trimmed = prompt.trim();
  const patterns = [
    /\bmax(?:imum)?\s+iterations?\s*[:=]?\s*(\d+)\b/i,
    /\bmax(?:imum)?\s+(\d+)\s+iterations?\b/i,
    /\biteration\s+budget\s*[:=]?\s*(\d+)\b/i,
  ];

  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let focus = trimmed;
  for (const pattern of patterns) {
    const match = focus.match(pattern);
    if (!match) {
      continue;
    }

    const parsedCount = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(parsedCount) && parsedCount >= 1) {
      maxIterations = Math.min(parsedCount, MAX_ALLOWED_ITERATIONS);
    }
    focus = `${focus.slice(0, match.index)} ${focus.slice((match.index ?? 0) + match[0].length)}`;
    break;
  }

  focus = focus
    .replace(/^[\s,;:.-]+/, "")
    .replace(/[\s,;:.-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    focus: focus || undefined,
    maxIterations,
  };
}

function formatIterationProgress(iteration: number, maxIterations: number): string {
  return `Iteration ${iteration}/${maxIterations}`;
}

function loadArtifacts(state: Simplify2State, ctx: ProcedureApi): Simplify2State {
  const focusId = state.focusRef.id;
  if (!focusId) {
    throw new Error("Simplify2 focus state is missing a focus id.");
  }
  const paths = resolveSimplify2Paths(
    state.artifacts.repoRoot ?? ctx.cwd,
    focusId,
  );
  const memory = readOrInitializeArchitectureMemory(paths, state.originalPrompt);
  const journal = readOrInitializeJournal(paths);
  const testMap = refreshTestMap(paths);
  const focusHash = computeFocusHash(state);
  const analysisFingerprint = computeRepoFingerprint({ cwd: paths.repoRoot }).fingerprint;
  const observationCache = readOrInitializeObservationCache(paths, focusHash, analysisFingerprint);
  const analysisCache = readOrInitializeAnalysisCache(paths, focusHash, analysisFingerprint);

  return {
    ...state,
    artifacts: {
      ...state.artifacts,
      repoRoot: paths.repoRoot,
      storageDir: paths.storageDir,
      indexPath: paths.indexPath,
      focusesDir: paths.focusesDir,
      focusDir: paths.focusDir,
      focusPath: paths.focusPath,
      statePath: paths.statePath,
      architectureMemoryPath: paths.architectureMemoryPath,
      journalPath: paths.journalPath,
      testMapPath: paths.testMapPath,
      observationsPath: paths.observationsPath,
      analysisCachePath: paths.analysisCachePath,
    },
    analysisCache: {
      focusHash,
      analysisFingerprint,
      observationsLoaded: observationCache.observations.length > 0,
      reusedObservationIds: normalizeStrings(analysisCache.reusableObservationIds),
      staleObservationIds: normalizeStrings(analysisCache.staleObservationIds),
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
  ctx: ProcedureApi,
): Promise<Simplify2State> {
  state.mode = "explore";
  const proposalResult = await ctx.agent.run(
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
  ctx: ProcedureApi,
  scopedPaths: string[] = [],
  reuseCachedObservations = false,
): Promise<Simplify2State> {
  const result = await ctx.agent.run(
    buildObservationPrompt(state, scopedPaths, reuseCachedObservations),
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
  ctx: ProcedureApi,
): Promise<Simplify2State> {
  const hypothesisResult = await ctx.agent.run(
    buildHypothesisPrompt(state),
    HypothesisBatchType,
    { stream: false },
  );
  const hypothesisBatch = expectData(hypothesisResult, "Missing hypotheses");
  const rankingResult = await ctx.agent.run(
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
  ctx: ProcedureApi,
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

    ctx.ui.text(`Applying ${next.hypothesis.title}...\n`);
    current = await applySimplificationSlice(current, next.hypothesis, ctx);
    current = await validateAndReconcile(current, ctx);

    const completion = maybeFinishAfterApply(current);
    if (completion) {
      return completion;
    }
    current = await commitAppliedSlice(current, next.hypothesis, ctx);
    const postCommitCompletion = maybeFinishAfterCommit(current);
    if (postCommitCompletion) {
      return postCommitCompletion;
    }

    current = resetNotebookForFreshAnalysis(current);
    ctx.ui.text(`Continuing simplify2 analysis for ${formatIterationProgress(current.iteration, current.maxIterations)}...\n`);
    current = await analyzeCurrentFocus(current, ctx);
  }
}

async function applySimplificationSlice(
  state: Simplify2State,
  hypothesis: SimplifyHypothesis,
  ctx: ProcedureApi,
): Promise<Simplify2State> {
  state.mode = "apply";
  const selectedHypothesis = withStableHypothesisIdentity(hypothesis);
  const selectedSlice = selectMinimalTrustedTestSlice(state, hypothesis);
  const applyResult = await ctx.agent.run(
    buildApplyPrompt(state, selectedHypothesis, selectedSlice),
    SimplifyApplyResultType,
    { stream: false },
  );
  const applied = expectData(applyResult, "Missing simplify2 apply result");
  const nextState: Simplify2State = {
    ...state,
    notebook: {
      ...state.notebook,
      latestApply: {
        hypothesisId: selectedHypothesis.canonicalId ?? selectedHypothesis.id,
        sourceHypothesisId: selectedHypothesis.sourceHypothesisId ?? selectedHypothesis.id,
        title: selectedHypothesis.title,
        decision: {
          kind: selectedHypothesis.kind,
          risk: selectedHypothesis.risk,
          summary: selectedHypothesis.summary,
          rationale: selectedHypothesis.rationale,
          rankingReason: selectedHypothesis.rankingReason,
          checkpointReason: selectedHypothesis.checkpointReason,
          expectedDelta: selectedHypothesis.expectedDelta,
          implementationScope: normalizePaths(selectedHypothesis.implementationScope),
          testImplications: normalizeStrings(selectedHypothesis.testImplications),
          evidence: selectedHypothesis.evidence,
        },
        result: {
          ...applied,
          touchedFiles: normalizePaths(applied.touchedFiles),
          conceptualChanges: normalizeStrings(applied.conceptualChanges),
          testChanges: normalizeStrings(applied.testChanges),
          validationNotes: normalizeStrings(applied.validationNotes),
        },
      },
      currentCheckpoint: undefined,
      candidateHypotheses: state.notebook.candidateHypotheses.filter((candidate) =>
        getHypothesisCanonicalId(candidate) !== getHypothesisCanonicalId(selectedHypothesis)),
      openQuestions: [],
      status: "active",
    },
    history: {
      ...state.history,
      appliedHypothesisIds: uniqueStrings([
        ...state.history.appliedHypothesisIds,
        getHypothesisCanonicalId(selectedHypothesis),
      ]),
    },
    testContext: {
      ...state.testContext,
      selectedSlice,
      changedSubsystems: inferRelevantSubsystems(selectedHypothesis),
    },
  };
  return recordAppliedHypothesis(nextState, selectedHypothesis);
}

async function validateAndReconcile(
  state: Simplify2State,
  ctx: ProcedureApi,
): Promise<Simplify2State> {
  state.mode = "reconcile";
  const validation = runSelectedValidation(state);
  const reconciliationResult = await ctx.agent.run(
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

async function commitAppliedSlice(
  state: Simplify2State,
  hypothesis: SimplifyHypothesis,
  ctx: ProcedureApi,
): Promise<Simplify2State> {
  const latestApply = state.notebook.latestApply;
  if (!latestApply) {
    return state;
  }

  const commitContext = buildCommitContext(state, hypothesis);
  try {
    const result = await ctx.procedures.run<NanobossCommitProcedureResult>("nanoboss/commit", commitContext);
    const commitResult = expectData(result, "Missing simplify2 commit result");
    const commit = createCommitStatus({
      succeeded: commitResult.checks.passed && commitResult.commit !== undefined,
      commitContext,
      display: getRunResultDisplay(result),
      summary: result.summary,
    });
    return appendJournalAfterCommit(applyCommitStatus(state, commit), commit);
  } catch (error) {
    const message = formatErrorMessage(error);
    const commit = createCommitStatus({
      succeeded: false,
      commitContext,
      display: `Automatic commit failed: ${message}`,
    });
    return appendJournalAfterCommit(applyCommitStatus(state, commit), commit);
  }
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

  return undefined;
}

function maybeFinishAfterCommit(state: Simplify2State): ProcedureResult | undefined {
  const latestApply = state.notebook.latestApply;
  const lead = buildLatestApplyLead(state);
  if (latestApply?.commit?.status === "failed") {
    return buildFinishedResult(
      markFinished(state),
      `Automatic commit failed after applying ${latestApply.title}.`,
      lead,
    );
  }

  if (state.history.appliedHypothesisIds.length >= state.maxIterations) {
    return buildFinishedResult(
      markFinished(state),
      state.maxIterations === 1
        ? (latestApply
          ? `Landed one simplify2 slice for this focus after applying ${latestApply.title}.`
          : "Landed one simplify2 slice for this focus.")
        : (latestApply
          ? `Reached simplify2 iteration budget (${state.maxIterations}) after applying ${latestApply.title}.`
          : `Reached simplify2 iteration budget (${state.maxIterations}).`),
      lead,
    );
  }

  return undefined;
}

async function interpretHumanReply(
  prompt: string,
  state: Simplify2State,
  ctx: ProcedureApi,
): Promise<SimplifyHumanDecision> {
  const result = await ctx.agent.run(
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
  const resolvedHypothesisId = resolveCanonicalHypothesisId(state, decision.hypothesisId);
  const next: Simplify2State = {
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
      rejectedHypothesisIds: decision.kind === "reject_hypothesis" && resolvedHypothesisId
        ? uniqueStrings([...state.history.rejectedHypothesisIds, resolvedHypothesisId])
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
        ...normalizeResolvedHypothesisIds(state, reconciliation.resolvedHypothesisIds),
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

function appendJournalAfterCommit(
  state: Simplify2State,
  commit: SimplifyCommitStatus,
): Simplify2State {
  const latestApply = state.notebook.latestApply;
  const entry = createJournalEntry({
    kind: "run",
    summary: commit.status === "created"
      ? `Committed simplify2 slice: ${latestApply?.title ?? "latest slice"}`
      : `Failed to commit simplify2 slice: ${latestApply?.title ?? "latest slice"}`,
    details: [
      commit.summary,
      commit.display,
      commit.commitContext,
    ],
    hypothesisId: latestApply?.hypothesisId,
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

function applyCommitStatus(
  state: Simplify2State,
  commit: SimplifyCommitStatus,
): Simplify2State {
  const latestApply = state.notebook.latestApply;
  if (!latestApply) {
    return state;
  }

  return {
    ...state,
    notebook: {
      ...state.notebook,
      latestApply: {
        ...latestApply,
        commit,
      },
    },
  };
}

function createCommitStatus(params: {
  succeeded: boolean;
  commitContext: string;
  display?: string;
  summary?: string;
}): SimplifyCommitStatus {
  const display = (params.display ?? params.summary ?? "").trim();
  const fallback = params.succeeded
    ? "Created a simplify2 slice commit."
    : "Failed to create a simplify2 slice commit.";
  return {
    status: params.succeeded ? "created" : "failed",
    commitContext: params.commitContext,
    summary: summarizeText(display || fallback, 240),
    display: display || fallback,
  };
}

function buildCommitContext(
  state: Simplify2State,
  hypothesis: SimplifyHypothesis,
): string {
  const latestApply = state.notebook.latestApply;
  const validation = state.testContext.lastValidation;
  return [
    `commit the simplify2 slice "${hypothesis.title}"`,
    latestApply?.result.summary ? `applied summary: ${latestApply.result.summary}` : "",
    validation ? `validation: ${validation.status}` : "",
    "keep the message concise and focused on the conceptual simplification",
  ].filter(Boolean).join("; ");
}

function buildPausedResult(
  state: Simplify2State,
  question: string,
): ProcedureResult {
  const persisted = syncPersistedFocusState({
    ...state,
    notebook: {
      ...state.notebook,
      status: "awaiting_human",
    },
  });
  const best = getSelectedCheckpointHypothesis(persisted);
  return {
    display: renderPausedDisplay(persisted, question),
    summary: best
      ? `simplify2: paused on ${best.title}`
      : "simplify2: paused for checkpoint",
    memory: best
      ? `Simplify2 paused on "${best.title}".`
      : "Simplify2 paused for a checkpoint.",
    pause: {
      question,
      state: persisted,
      inputHint: "Reply with approve, reject, redirect the search, revise the design, or stop",
      suggestedReplies: SUGGESTED_REPLIES,
      continuationUi: SIMPLIFY2_CONTINUATION_UI,
    },
  };
}

function buildFinishedResult(
  state: Simplify2State,
  reason: string,
  lead?: string,
): ProcedureResult {
  const persisted = syncPersistedFocusState(state);
  const latestApply = persisted.notebook.latestApply;
  const validation = persisted.testContext.lastValidation;
  const appliedCount = persisted.history.appliedHypothesisIds.length;
  const rejectedCount = persisted.history.rejectedHypothesisIds.length;
  return {
    data: {
      focus: persisted.originalPrompt,
      iteration: persisted.iteration,
      maxIterations: persisted.maxIterations,
      appliedCount,
      rejectedCount,
      validationStatus: validation?.status,
      latestHypothesis: latestApply?.title,
    },
    display: [
      lead,
      "Simplify2 is done for now.",
      `${formatIterationProgress(persisted.iteration, persisted.maxIterations)}.`,
      `Reason: ${reason}`,
      `Applied hypotheses: ${appliedCount}.`,
      `Rejected hypotheses: ${rejectedCount}.`,
      renderValidationLine(validation),
    ].filter(Boolean).join("\n") + "\n",
    summary: `simplify2: finished after ${persisted.iteration} iteration${persisted.iteration === 1 ? "" : "s"}`,
    memory: `Simplify2 finished after ${persisted.iteration} iteration${persisted.iteration === 1 ? "" : "s"}.`,
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
  const hypothesis = state.notebook.candidateHypotheses
    .map((candidate) => withStableHypothesisIdentity(candidate))
    .find((candidate) => hypothesisMatchesIdentifier(candidate, resolvedId));
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

function resolveSimplify2StorageRoot(cwd: string): {
  repoRoot: string;
  storageDir: string;
  indexPath: string;
  focusesDir: string;
} {
  const repoRoot = resolveRepoRootOrCwd(cwd);
  try {
    ensureGitLocalExclude(repoRoot, SIMPLIFY2_LOCAL_EXCLUDE_PATTERN);
  } catch {
    // The repo-local exclude is best-effort when git metadata is unavailable.
  }

  const storageDir = resolveRepoArtifactDir(repoRoot, ...SIMPLIFY2_STORAGE_SUBDIR);
  const root = {
    repoRoot,
    storageDir,
    indexPath: join(storageDir, "index.json"),
    focusesDir: join(storageDir, SIMPLIFY2_FOCUSES_SUBDIR),
  };
  migrateLegacySingletonArtifacts(root);
  return root;
}

function resolveSimplify2Paths(cwd: string, focusId: string): Simplify2Paths {
  const root = resolveSimplify2StorageRoot(cwd);
  return buildSimplify2Paths(root, focusId);
}

function buildSimplify2Paths(
  root: ReturnType<typeof resolveSimplify2StorageRoot>,
  focusId: string,
): Simplify2Paths {
  const focusDir = join(root.focusesDir, focusId);
  return {
    repoRoot: root.repoRoot,
    storageDir: root.storageDir,
    indexPath: root.indexPath,
    focusesDir: root.focusesDir,
    focusDir,
    focusPath: join(focusDir, "focus.json"),
    statePath: join(focusDir, "state.json"),
    architectureMemoryPath: join(focusDir, "architecture-memory.json"),
    journalPath: join(focusDir, "journal.json"),
    testMapPath: join(focusDir, "test-map.json"),
    observationsPath: join(focusDir, "observations.json"),
    analysisCachePath: join(focusDir, "analysis-cache.json"),
  };
}

function resolveRepoRootOrCwd(cwd: string): string {
  try {
    return resolveGitRepoRoot(cwd);
  } catch {
    return resolve(cwd);
  }
}

function requireSimplify2StorageRoot(state: Simplify2State): ReturnType<typeof resolveSimplify2StorageRoot> {
  const repoRoot = requireArtifactPath(state.artifacts.repoRoot, "repo root");
  return resolveSimplify2StorageRoot(repoRoot);
}

function readOrInitializeFocusIndex(
  root: ReturnType<typeof resolveSimplify2StorageRoot>,
): Simplify2FocusIndex {
  const fallback = createDefaultFocusIndex();
  const index = readJsonFile(root.indexPath, Simplify2FocusIndexType, fallback);
  if (!existsSync(root.indexPath)) {
    writeJsonFile(root.indexPath, index);
  }
  return index;
}

function writeFocusIndex(
  root: ReturnType<typeof resolveSimplify2StorageRoot>,
  index: Simplify2FocusIndex,
): void {
  writeJsonFile(root.indexPath, {
    ...index,
    updatedAt: nowIso(),
    entries: sortFocusEntries(index.entries),
  });
}

function listVisibleFocusEntries(index: Simplify2FocusIndex): Simplify2FocusIndexEntry[] {
  return sortFocusEntries(index.entries.filter((entry) => entry.status !== "archived"));
}

function sortFocusEntries(entries: Simplify2FocusIndexEntry[]): Simplify2FocusIndexEntry[] {
  return [...entries].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
    || left.title.localeCompare(right.title));
}

function archiveFocusEntry(
  root: ReturnType<typeof resolveSimplify2StorageRoot>,
  focusId: string,
): void {
  const index = readOrInitializeFocusIndex(root);
  const entry = index.entries.find((candidate) => candidate.id === focusId);
  if (!entry) {
    return;
  }
  entry.status = "archived";
  entry.updatedAt = nowIso();
  entry.pendingContinuation = undefined;
  writeFocusIndex(root, index);

  const paths = buildSimplify2Paths(root, focusId);
  const metadata = readJsonFile(paths.focusPath, Simplify2FocusMetadataType, createDefaultFocusMetadata(entry));
  writeJsonFile(paths.focusPath, {
    ...metadata,
    status: "archived",
    updatedAt: entry.updatedAt,
    pendingContinuation: undefined,
  });
}

function migrateLegacySingletonArtifacts(
  root: ReturnType<typeof resolveSimplify2StorageRoot>,
): void {
  if (existsSync(root.indexPath)) {
    return;
  }

  const legacyPaths = {
    architectureMemoryPath: join(root.storageDir, "architecture-memory.json"),
    journalPath: join(root.storageDir, "journal.json"),
    testMapPath: join(root.storageDir, "test-map.json"),
    observationsPath: join(root.storageDir, "observations.json"),
    analysisCachePath: join(root.storageDir, "analysis-cache.json"),
  };
  if (!Object.values(legacyPaths).some((path) => existsSync(path))) {
    return;
  }

  const legacyMemory = readJsonFile(
    legacyPaths.architectureMemoryPath,
    Simplify2ArchitectureMemoryType,
    createDefaultArchitectureMemory(DEFAULT_FOCUS_TITLE),
  );
  const rawPrompt = legacyMemory.focus.trim() || DEFAULT_FOCUS_TITLE;
  const normalizedFocus = normalizeFocusText(rawPrompt);
  const createdAt = nowIso();
  const entry: Simplify2FocusIndexEntry = {
    id: createFocusId(normalizedFocus),
    title: summarizeText(rawPrompt, 80) || DEFAULT_FOCUS_TITLE,
    normalizedFocus,
    rawPrompt,
    createdAt,
    updatedAt: createdAt,
    status: "active",
  };
  const paths = buildSimplify2Paths(root, entry.id);
  writeJsonFile(paths.focusPath, createDefaultFocusMetadata(entry));
  if (existsSync(legacyPaths.architectureMemoryPath)) {
    writeJsonFile(paths.architectureMemoryPath, legacyMemory);
  }
  if (existsSync(legacyPaths.journalPath)) {
    writeJsonFile(paths.journalPath, readJsonFile(legacyPaths.journalPath, Simplify2JournalType, createDefaultJournal()));
  }
  if (existsSync(legacyPaths.testMapPath)) {
    writeJsonFile(paths.testMapPath, readJsonFile(legacyPaths.testMapPath, Simplify2TestMapType, createDefaultTestMap()));
  }
  if (existsSync(legacyPaths.observationsPath)) {
    writeJsonFile(
      paths.observationsPath,
      readJsonFile(
        legacyPaths.observationsPath,
        Simplify2ObservationCacheType,
        createDefaultObservationCache(hashFocusPayload({
          originalPrompt: rawPrompt,
          scope: [],
          exclusions: [],
          goals: [rawPrompt],
          constraints: [],
          guidance: [],
        }), ""),
      ),
    );
  }
  if (existsSync(legacyPaths.analysisCachePath)) {
    writeJsonFile(
      paths.analysisCachePath,
      readJsonFile(legacyPaths.analysisCachePath, Simplify2AnalysisCacheType, createDefaultAnalysisCache("", "")),
    );
  }
  writeFocusIndex(root, {
    version: 1,
    updatedAt: createdAt,
    entries: [entry],
  });
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

function readOrInitializeObservationCache(
  paths: Simplify2Paths,
  focusHash: string,
  analysisFingerprint: string,
): Simplify2ObservationCache {
  const fallback = createDefaultObservationCache(focusHash, analysisFingerprint);
  const cache = readJsonFile(paths.observationsPath, Simplify2ObservationCacheType, fallback);
  const normalized = cache.focusHash === focusHash ? cache : fallback;
  if (!existsSync(paths.observationsPath) || normalized !== cache) {
    writeJsonFile(paths.observationsPath, normalized);
  }
  return normalized;
}

function readOrInitializeAnalysisCache(
  paths: Simplify2Paths,
  focusHash: string,
  analysisFingerprint: string,
): Simplify2AnalysisCache {
  const fallback = createDefaultAnalysisCache(focusHash, analysisFingerprint);
  const cache = readJsonFile(paths.analysisCachePath, Simplify2AnalysisCacheType, fallback);
  const normalized = cache.focusHash === focusHash ? cache : fallback;
  if (!existsSync(paths.analysisCachePath) || normalized !== cache) {
    writeJsonFile(paths.analysisCachePath, normalized);
  }
  return normalized;
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

function buildObservationPrompt(
  state: Simplify2State,
  scopedPaths: string[] = [],
  reuseCachedObservations = false,
): string {
  const normalizedScopedPaths = normalizePaths(scopedPaths);
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
    reuseCachedObservations
      ? "Reuse the notebook context as preserved observations and focus only on refreshing changed or adjacent areas."
      : "",
    normalizedScopedPaths.length > 0
      ? `Scope this observation refresh to these changed paths first: ${normalizedScopedPaths.join(", ")}`
      : "",
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
    "7. Validation commands must use `bun test`, never `npm test`.",
    "8. Return JSON only with `summary`, `touchedFiles`, `conceptualChanges`, `testChanges`, and `validationNotes`.",
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
  const overlapSuppression = readCurrentAnalysisCache(state).overlapSuppression;
  return hypotheses.hypotheses
    .map((hypothesis) => ({
      draft: hypothesis,
      canonicalId: computeCanonicalHypothesisId(hypothesis),
    }))
    .filter(({ canonicalId }) =>
      !state.history.appliedHypothesisIds.includes(canonicalId)
      && !state.history.rejectedHypothesisIds.includes(canonicalId)
      && !state.history.resolvedHypothesisIds.includes(canonicalId))
    .reduce<SimplifyHypothesis[]>((result, { draft, canonicalId }) => {
      const ranking = rankingById.get(draft.id);
      const overlap = findHighestHypothesisOverlap(draft, overlapSuppression);
      if (overlap && overlap.score >= 0.85 && overlap.hasNoDistinctScope) {
        return result;
      }

      const score = ranking?.score;
      const overlapPenalty = overlap && overlap.score >= 0.75 ? Math.ceil(overlap.score * 5) : 0;
      const rankingReason = [
        ranking?.reason,
        overlap && overlap.score >= 0.75
          ? `Overlaps with applied hypothesis ${overlap.entry.hypothesisId} (${Math.round(overlap.score * 100)}%).`
          : "",
      ].filter(Boolean).join(" ");
      const candidate: SimplifyHypothesis = {
        ...draft,
        canonicalId,
        sourceHypothesisId: draft.id,
        score: Math.max(0, (typeof score === "number" && Number.isFinite(score) ? score : 0) - overlapPenalty),
        needsHumanCheckpoint: overlap && overlap.score >= 0.75 && draft.risk !== "low"
          ? true
          : (ranking?.needsHumanCheckpoint ?? draft.needsHumanCheckpoint),
        ...(rankingReason ? { rankingReason } : {}),
      };
      if (SimplifyHypothesisType.validate(candidate)) {
        result.push(candidate);
      }
      return result;
    }, [])
    .sort((left, right) =>
      right.score - left.score
      || compareRisk(left.risk, right.risk)
      || left.title.localeCompare(right.title));
}

async function analyzeCurrentFocus(
  state: Simplify2State,
  ctx: ProcedureApi,
): Promise<Simplify2State> {
  const reusePlan = planAnalysisReuse(state);
  state.analysisCache = {
    focusHash: computeFocusHash(state),
    analysisFingerprint: reusePlan.analysisFingerprint,
    observationsLoaded: reusePlan.reusableEntries.length > 0,
    reusedObservationIds: reusePlan.reusableEntries.map((entry) => entry.observation.id),
    staleObservationIds: reusePlan.staleEntries.map((entry) => entry.observation.id),
  };
  if (reusePlan.reusableEntries.length > 0) {
    ctx.ui.text(`Reusing ${reusePlan.reusableEntries.length} cached simplify2 observations...\n`);
    state = {
      ...state,
      notebook: {
        ...state.notebook,
        observations: reusePlan.reusableEntries.map((entry) => entry.observation),
      },
    };
  }

  if (reusePlan.shouldRunFullRefresh) {
    ctx.ui.text("Refreshing architecture memory for the current focus...\n");
    state = await refreshArchitectureMemory(state, ctx);

    ctx.ui.text("Collecting conceptual simplification observations...\n");
    state = await collectObservations(state, ctx);
  } else if (reusePlan.staleEntries.length > 0) {
    ctx.ui.text("Refreshing conceptual observations for touched files...\n");
    state = await collectObservations(
      state,
      ctx,
      reusePlan.touchedFiles,
      reusePlan.reusableEntries.length > 0,
    );
  } else {
    ctx.ui.text("Skipping full simplify2 research refresh because cached observations are still valid.\n");
  }

  ctx.ui.text("Generating and ranking simplification hypotheses...\n");
  state = await generateAndRankHypotheses(state, ctx);
  return persistAnalysisArtifacts(state, reusePlan.analysisFingerprint);
}

function buildLatestApplyLead(state: Simplify2State): string | undefined {
  const latestApply = state.notebook.latestApply;
  if (!latestApply) {
    return undefined;
  }

  return [
    `Applied: ${latestApply.title}.`,
    latestApply.result.summary.trim(),
    renderAppliedDecisionExplanation(latestApply, state.testContext.selectedSlice),
    renderTouchedFiles(latestApply.result.touchedFiles),
    renderValidationLine(state.testContext.lastValidation),
    renderCommitLine(latestApply.commit),
  ].filter(Boolean).join("\n");
}

function renderPausedDisplay(state: Simplify2State, question: string, lead?: string): string {
  const selected = getSelectedCheckpointHypothesis(state);
  const lines = [
    lead,
    buildLatestApplyLead(state),
    renderPausedProposalSummary(selected, state.iteration, state.maxIterations),
    renderHypothesisCandidates(state.notebook.candidateHypotheses),
    renderSelectedHypothesisSummary(selected),
    question,
    renderPausedActions(),
  ].filter(Boolean);
  return `${lines.join("\n\n")}\n`;
}

function buildBlockedDirtyWorktreeStartResult(cwd: string): ProcedureResult | undefined {
  const status = getSimplify2DirtyWorktreeStatus(cwd);
  if (!status) {
    return undefined;
  }

  return {
    display: renderDirtyWorktreeMessage(status.repoRoot, status.output),
    summary: "simplify2: blocked by dirty worktree",
    memory: "Simplify2 refused to start because the worktree was dirty.",
  };
}

function buildBlockedDirtyWorktreeResumeResult(
  state: Simplify2State,
  cwd: string,
): ProcedureResult | undefined {
  const status = getSimplify2DirtyWorktreeStatus(cwd);
  if (!status) {
    return undefined;
  }

  const question = state.notebook.currentCheckpoint?.question ?? "Clean the worktree, then reply again.";
  const lead = [
    "Simplify2 cannot continue until the git worktree is clean again.",
    renderDirtyWorktreeMessage(status.repoRoot, status.output).trim(),
  ].join("\n\n");
  const persisted = syncPersistedFocusState({
    ...state,
    notebook: {
      ...state.notebook,
      status: "awaiting_human",
    },
  });
  const best = getSelectedCheckpointHypothesis(persisted);
  return {
    display: renderPausedDisplay(persisted, question, lead),
    summary: best
      ? `simplify2: blocked by dirty worktree while paused on ${best.title}`
      : "simplify2: blocked by dirty worktree while paused",
    memory: "Simplify2 stayed paused because the worktree was dirty.",
    pause: {
      question,
      state: persisted,
      inputHint: "Reply with approve, reject, redirect the search, revise the design, or stop",
      suggestedReplies: SUGGESTED_REPLIES,
      continuationUi: SIMPLIFY2_CONTINUATION_UI,
    },
  };
}

function getSimplify2DirtyWorktreeStatus(cwd: string): { repoRoot: string; output: string } | undefined {
  try {
    const repoRoot = resolveGitRepoRoot(cwd);
    const output = getWorktreeStatus(repoRoot);
    return output.length > 0 ? { repoRoot, output } : undefined;
  } catch {
    return undefined;
  }
}

function renderDirtyWorktreeMessage(repoRoot: string, statusOutput: string): string {
  return [
    "Simplify2 requires a clean git worktree before it can apply or commit a slice.",
    `Repo root: ${repoRoot}`,
    "Current git status (--porcelain=v1 --untracked-files=all):",
    statusOutput,
  ].join("\n") + "\n";
}

function maybeCreateCheckpoint(hypotheses: SimplifyHypothesis[]): SimplifyCheckpoint | undefined {
  const best = hypotheses[0];
  if (!best || (!best.needsHumanCheckpoint && best.risk === "low" && best.kind !== "design_update")) {
    return undefined;
  }
  return buildCheckpoint(best);
}

function buildCheckpoint(hypothesis: SimplifyHypothesis): SimplifyCheckpoint {
  const normalizedHypothesis = withStableHypothesisIdentity(hypothesis);
  return {
    hypothesisId: normalizedHypothesis.canonicalId ?? normalizedHypothesis.id,
    kind: checkpointKindForHypothesis(normalizedHypothesis),
    question: buildCheckpointQuestion(normalizedHypothesis),
    options: checkpointOptionsForHypothesis(normalizedHypothesis),
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

function createDefaultObservationCache(
  focusHash: string,
  analysisFingerprint: string,
): Simplify2ObservationCache {
  return {
    version: 1,
    updatedAt: nowIso(),
    focusHash,
    analysisFingerprint,
    observations: [],
  };
}

function createDefaultAnalysisCache(
  focusHash: string,
  analysisFingerprint: string,
): Simplify2AnalysisCache {
  return {
    version: 1,
    updatedAt: nowIso(),
    focusHash,
    analysisFingerprint,
    lastTouchedFiles: [],
    reusableObservationIds: [],
    staleObservationIds: [],
    overlapSuppression: [],
  };
}

function createDefaultFocusIndex(): Simplify2FocusIndex {
  return {
    version: 1,
    updatedAt: nowIso(),
    entries: [],
  };
}

function createDefaultFocusMetadata(entry: Simplify2FocusIndexEntry): Simplify2FocusMetadata {
  return {
    version: 1,
    id: entry.id,
    title: entry.title,
    normalizedFocus: entry.normalizedFocus,
    rawPrompt: entry.rawPrompt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    status: entry.status,
    lastSummary: entry.lastCheckpointQuestion ?? entry.lastCommitSummary,
    lastCheckpointQuestion: entry.lastCheckpointQuestion,
    lastCommitSummary: entry.lastCommitSummary,
    lastTouchedFiles: normalizePaths(entry.lastTouchedFiles ?? []),
    pendingContinuation: entry.pendingContinuation,
  };
}

function readPersistedFocusState(paths: Simplify2Paths): Simplify2State | undefined {
  if (!existsSync(paths.statePath)) {
    return undefined;
  }
  const raw = JSON.parse(readFileSync(paths.statePath, "utf8")) as unknown;
  if (!Simplify2StateType.validate(raw)) {
    return undefined;
  }
  return {
    ...raw,
    version: 2,
  };
}

function syncPersistedFocusState(state: Simplify2State): Simplify2State {
  if (!state.focusRef.id || !state.artifacts.statePath || !state.artifacts.focusPath || !state.artifacts.indexPath) {
    return state;
  }

  const statePath = state.artifacts.statePath;
  const syncedState: Simplify2State = {
    ...state,
    focusRef: {
      ...state.focusRef,
      status: inferFocusStatus(state),
    },
  };
  writeJsonFile(statePath, syncedState);
  syncFocusCatalogFromState(syncedState);
  return syncedState;
}

function syncFocusCatalogFromState(state: Simplify2State): void {
  const root = requireSimplify2StorageRoot(state);
  const index = readOrInitializeFocusIndex(root);
  const status = inferFocusStatus(state);
  const entry = buildFocusIndexEntryFromState(state, status);
  const existingIndex = index.entries.findIndex((candidate) => candidate.id === entry.id);
  const entries = [...index.entries];
  if (existingIndex >= 0) {
    entries[existingIndex] = entry;
  } else {
    entries.push(entry);
  }
  writeFocusIndex(root, {
    ...index,
    entries,
  });

  const paths = buildSimplify2Paths(root, entry.id);
  const existingFocus = readJsonFile(paths.focusPath, Simplify2FocusMetadataType, createDefaultFocusMetadata(entry));
  const nextMetadata: Simplify2FocusMetadata = {
    ...existingFocus,
    version: 1,
    id: entry.id,
    title: entry.title,
    normalizedFocus: entry.normalizedFocus,
    rawPrompt: entry.rawPrompt,
    createdAt: existingFocus.createdAt || entry.createdAt,
    updatedAt: entry.updatedAt,
    status,
    lastSummary: entry.lastCheckpointQuestion ?? entry.lastCommitSummary ?? state.notebook.latestApply?.result.summary,
    lastCheckpointQuestion: entry.lastCheckpointQuestion,
    lastCommitSummary: entry.lastCommitSummary,
    lastTouchedFiles: normalizePaths(entry.lastTouchedFiles ?? existingFocus.lastTouchedFiles),
    pendingContinuation: entry.pendingContinuation,
  };
  writeJsonFile(paths.focusPath, nextMetadata);
}

function buildFocusIndexEntryFromState(
  state: Simplify2State,
  status: Simplify2FocusStatus,
): Simplify2FocusIndexEntry {
  const existingMetadata = state.artifacts.focusPath
    ? readJsonFile(
      state.artifacts.focusPath,
      Simplify2FocusMetadataType,
      createDefaultFocusMetadata({
        id: requireFocusId(state),
        title: state.focusRef.title ?? (summarizeText(state.originalPrompt, 80) || DEFAULT_FOCUS_TITLE),
        normalizedFocus: state.focusRef.normalizedFocus ?? normalizeFocusText(state.originalPrompt),
        rawPrompt: state.originalPrompt,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        status,
      }),
    )
    : undefined;
  const latestApply = state.notebook.latestApply;
  const checkpointQuestion = state.notebook.currentCheckpoint?.question;
  return {
    id: requireFocusId(state),
    title: state.focusRef.title ?? existingMetadata?.title ?? (summarizeText(state.originalPrompt, 80) || DEFAULT_FOCUS_TITLE),
    normalizedFocus: state.focusRef.normalizedFocus ?? existingMetadata?.normalizedFocus ?? normalizeFocusText(state.originalPrompt),
    rawPrompt: state.originalPrompt,
    createdAt: existingMetadata?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    status,
    lastCheckpointQuestion: checkpointQuestion,
    lastCommitSummary: latestApply?.commit?.summary ?? existingMetadata?.lastCommitSummary,
    lastTouchedFiles: normalizePaths(latestApply?.result.touchedFiles ?? existingMetadata?.lastTouchedFiles ?? []),
    pendingContinuation: checkpointQuestion
      ? {
          question: checkpointQuestion,
          updatedAt: nowIso(),
        }
      : undefined,
  };
}

function inferFocusStatus(state: Simplify2State): Simplify2FocusStatus {
  if (state.focusRef.status === "archived") {
    return "archived";
  }
  if (state.notebook.status === "awaiting_human" && state.notebook.currentCheckpoint) {
    return "paused";
  }
  if (state.mode === "finished" || state.notebook.status === "closed") {
    return "finished";
  }
  return "active";
}

function requireFocusId(state: Simplify2State): string {
  if (!state.focusRef.id) {
    throw new Error("Simplify2 state is missing a focus id.");
  }
  return state.focusRef.id;
}

function normalizeFocusText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[\s,;:!?.-]+/u, "")
    .replace(/[\s,;:!?.-]+$/u, "")
    .replace(/\s+/gu, " ");
}

function createFocusId(normalizedFocus: string): string {
  return `focus-${createHash("sha256").update(normalizedFocus).digest("hex").slice(0, 12)}`;
}

function interpretFocusPickerReply(
  reply: string,
  entries: Simplify2FocusIndexEntry[],
):
  | { kind: "cancel" }
  | { kind: "invalid"; reason: string }
  | { kind: "archive"; entry: Simplify2FocusIndexEntry }
  | { kind: "continue"; entry: Simplify2FocusIndexEntry }
  | { kind: "new"; focus: string } {
  const trimmed = reply.trim();
  if (trimmed.length === 0) {
    return { kind: "invalid", reason: "Reply with a focus choice, `new <focus>`, or `stop`." };
  }
  if (trimmed === "stop" || trimmed === "cancel") {
    return { kind: "cancel" };
  }

  const archiveMatch = trimmed.match(/^archive\s+(.+)$/i);
  if (archiveMatch) {
    const entry = resolveFocusPickerEntry(archiveMatch[1] ?? "", entries);
    return entry
      ? { kind: "archive", entry }
      : { kind: "invalid", reason: `Could not find focus ${JSON.stringify((archiveMatch[1] ?? "").trim())}.` };
  }

  const continueMatch = trimmed.match(/^continue\s+(.+)$/i);
  if (continueMatch) {
    const entry = resolveFocusPickerEntry(continueMatch[1] ?? "", entries);
    return entry
      ? { kind: "continue", entry }
      : { kind: "invalid", reason: `Could not find focus ${JSON.stringify((continueMatch[1] ?? "").trim())}.` };
  }

  const newMatch = trimmed.match(/^new\s+(.+)$/i);
  if (newMatch) {
    const focus = (newMatch[1] ?? "").trim();
    return focus.length > 0
      ? { kind: "new", focus }
      : { kind: "invalid", reason: "Provide a focus after `new`." };
  }

  const entry = resolveFocusPickerEntry(trimmed, entries);
  if (entry) {
    return { kind: "continue", entry };
  }

  return { kind: "new", focus: trimmed };
}

function resolveFocusPickerEntry(
  selector: string,
  entries: Simplify2FocusIndexEntry[],
): Simplify2FocusIndexEntry | undefined {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const ordered = sortFocusEntries(entries);
  const parsedIndex = Number.parseInt(trimmed, 10);
  if (Number.isInteger(parsedIndex) && parsedIndex >= 1 && parsedIndex <= ordered.length) {
    return ordered[parsedIndex - 1];
  }
  return ordered.find((entry) => entry.id === trimmed || entry.title === trimmed || entry.rawPrompt === trimmed);
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
  const isValid = Simplify2JournalEntryType.validate(entry as unknown);
  if (!isValid) {
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

function renderPausedProposalSummary(
  hypothesis: SimplifyHypothesis | undefined,
  iteration: number,
  maxIterations: number,
): string {
  const iterationLine = formatIterationProgress(iteration, maxIterations);
  if (!hypothesis) {
    return `${iterationLine}\nNo current checkpoint proposal.`;
  }

  return [
    iterationLine,
    "I have a simplification proposal:",
    `- title: ${hypothesis.title}`,
    `- summary: ${hypothesis.summary}`,
    `- kind/risk/score: ${hypothesis.kind} / ${hypothesis.risk} / ${hypothesis.score}`,
    `- scope: ${hypothesis.implementationScope.join(", ") || "(none listed)"}`,
    `- why this reduces conceptual complexity: ${hypothesis.rationale}`,
  ].join("\n");
}

function renderHypothesisCandidates(hypotheses: SimplifyHypothesis[]): string {
  if (hypotheses.length === 0) {
    return "I have proposed 0 hypotheses for this simplification.";
  }

  return [
    `I have proposed ${hypotheses.length} hypotheses for this simplification:`,
    ...hypotheses.map((hypothesis, index) => {
      const scope = hypothesis.implementationScope.join(", ") || "(none listed)";
      return `${index + 1}. ${hypothesis.title} | ${hypothesis.kind} | risk=${hypothesis.risk} | score=${hypothesis.score} | scope=${scope}`;
    }),
  ].join("\n");
}

function renderSelectedHypothesisSummary(hypothesis: SimplifyHypothesis | undefined): string | undefined {
  if (!hypothesis) {
    return undefined;
  }

  return [
    `I have selected hypothesis "${hypothesis.title}":`,
    `- ranking reason: ${hypothesis.rankingReason ?? "No ranking reason was recorded."}`,
    `- checkpoint reason: ${hypothesis.checkpointReason ?? `risk=${hypothesis.risk}`}`,
    `- concrete change: ${hypothesis.summary}`,
  ].join("\n");
}

function getSelectedCheckpointHypothesis(state: Simplify2State): SimplifyHypothesis | undefined {
  const checkpointHypothesisId = state.notebook.currentCheckpoint?.hypothesisId;
  if (checkpointHypothesisId) {
    return state.notebook.candidateHypotheses
      .map((hypothesis) => withStableHypothesisIdentity(hypothesis))
      .find((hypothesis) => hypothesisMatchesIdentifier(hypothesis, checkpointHypothesisId))
      ?? state.notebook.candidateHypotheses[0];
  }

  return state.notebook.candidateHypotheses[0];
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

function renderPausedActions(): string {
  return [
    "Available actions:",
    "1. approve it",
    "2. stop",
    "3. focus on tests instead",
    "4. something else",
  ].join("\n");
}

function renderTouchedFiles(files: string[]): string | undefined {
  const normalized = normalizePaths(files);
  return normalized.length > 0 ? `Touched files: ${normalized.join(", ")}` : undefined;
}

function renderAppliedDecisionExplanation(
  applied: SimplifyAppliedSlice,
  selectedSlice: TestSliceSelection[],
): string | undefined {
  const decision = applied.decision;
  if (!decision) {
    return undefined;
  }

  const lines = [
    "Why this change:",
    `- selected because: ${decision.rankingReason ?? "No explicit ranking reason was recorded."}`,
    `- simplification target: ${decision.summary}`,
    `- conceptual rationale: ${decision.rationale}`,
    `- expected payoff: ${renderExpectedDelta(decision.expectedDelta) ?? "No explicit delta was recorded."}`,
    `- intended scope: ${decision.implementationScope.join(", ") || "(none recorded)"}`,
    `- supporting evidence: ${renderEvidenceRefs(decision.evidence) ?? "(none recorded)"}`,
    `- test intent: ${decision.testImplications.join("; ") || "(none recorded)"}`,
    `- realized conceptual changes: ${applied.result.conceptualChanges.join("; ") || "(none recorded)"}`,
    `- realized test changes: ${applied.result.testChanges.join("; ") || "(none recorded)"}`,
    `- validation focus: ${renderSelectedValidationFocus(selectedSlice)}`,
    `- validation notes: ${applied.result.validationNotes.join("; ") || "(none recorded)"}`,
  ];
  if (decision.checkpointReason) {
    lines.splice(4, 0, `- checkpoint context: ${decision.checkpointReason}`);
  }
  return lines.join("\n");
}

function renderExpectedDelta(delta: SimplifyHypothesisExpectedDelta): string | undefined {
  const parts = [
    typeof delta.conceptsReduced === "number" ? `concepts -${delta.conceptsReduced}` : "",
    typeof delta.boundariesReduced === "number" ? `boundaries -${delta.boundariesReduced}` : "",
    typeof delta.exceptionsReduced === "number" ? `exceptions -${delta.exceptionsReduced}` : "",
    typeof delta.duplicateRepresentationsReduced === "number"
      ? `duplicate representations -${delta.duplicateRepresentationsReduced}`
      : "",
    delta.testRuntimeDelta ? `test runtime ${delta.testRuntimeDelta}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function renderEvidenceRefs(evidence: SimplifyEvidenceRef[]): string | undefined {
  const refs = evidence
    .map((entry) => `${entry.kind}:${normalizePath(entry.ref)}${entry.note ? ` (${entry.note})` : ""}`)
    .filter((entry) => entry.trim().length > 0)
    .slice(0, 6);
  return refs.length > 0 ? refs.join("; ") : undefined;
}

function renderSelectedValidationFocus(selectedSlice: TestSliceSelection[]): string {
  const paths = normalizePaths(selectedSlice.map((entry) => entry.path));
  return paths.join(", ") || "No trusted test slice matched the selected scope.";
}

function getRunResultDisplay(result: RunResult): string | undefined {
  if (!("display" in result) || typeof result.display !== "string") {
    return undefined;
  }

  return result.display;
}

function renderValidationLine(validation: ValidationSummary | undefined): string | undefined {
  if (!validation) {
    return undefined;
  }

  return `Validation: ${validation.status}. ${validation.outputSummary}`;
}

function renderCommitLine(commit: SimplifyCommitStatus | undefined): string | undefined {
  if (!commit) {
    return undefined;
  }

  return `Commit: ${commit.status}. ${commit.summary}`;
}

function persistAnalysisArtifacts(
  state: Simplify2State,
  analysisFingerprint: string,
): Simplify2State {
  const focusHash = computeFocusHash(state);
  const previousObservationCache = readCurrentObservationCache(state, analysisFingerprint);
  const previousEntriesByKey = new Map(
    previousObservationCache.observations.map((entry) => [observationCacheKey(entry.observation), entry]),
  );
  const observations: Simplify2ObservationCache = {
    version: 1,
    updatedAt: nowIso(),
    focusHash,
    analysisFingerprint,
    observations: state.notebook.observations.map((observation) => {
      const previous = previousEntriesByKey.get(observationCacheKey(observation));
      const sourcePaths = deriveObservationSourcePaths(observation);
      return {
        observation,
        sourcePaths: sourcePaths.length > 0 ? sourcePaths : (previous?.sourcePaths ?? []),
        evidenceRefs: observation.evidence,
        derivedFromArtifacts: previous?.derivedFromArtifacts ?? deriveObservationArtifacts(observation),
        stale: false,
      };
    }),
  };
  writeJsonFile(requireArtifactPath(state.artifacts.observationsPath, "observation cache"), observations);

  const previousAnalysisCache = readCurrentAnalysisCache(state);
  const analysisCache: Simplify2AnalysisCache = {
    ...previousAnalysisCache,
    version: 1,
    updatedAt: nowIso(),
    focusHash,
    analysisFingerprint,
    reusableObservationIds: observations.observations.map((entry) => entry.observation.id),
    staleObservationIds: [],
  };
  writeJsonFile(requireArtifactPath(state.artifacts.analysisCachePath, "analysis cache"), analysisCache);

  return {
    ...state,
    analysisCache: {
      focusHash,
      analysisFingerprint,
      observationsLoaded: observations.observations.length > 0,
      reusedObservationIds: analysisCache.reusableObservationIds,
      staleObservationIds: [],
    },
  };
}

function recordAppliedHypothesis(
  state: Simplify2State,
  hypothesis: SimplifyHypothesis,
): Simplify2State {
  const normalizedHypothesis = withStableHypothesisIdentity(hypothesis);
  const analysisCache = readCurrentAnalysisCache(state);
  const touchedFiles = normalizePaths(state.notebook.latestApply?.result.touchedFiles ?? normalizedHypothesis.implementationScope);
  const entry: Simplify2OverlapSuppressionEntry = {
    hypothesisId: normalizedHypothesis.canonicalId ?? normalizedHypothesis.id,
    titleTokens: extractTokens(normalizedHypothesis.title),
    summaryTokens: extractTokens(normalizedHypothesis.summary),
    normalizedScopeTokens: uniqueStrings(normalizedHypothesis.implementationScope.flatMap((path) => extractTokens(path))),
    touchedFiles,
    evidenceRefs: uniqueStrings(normalizedHypothesis.evidence.map((evidence) => normalizePath(evidence.ref))),
  };
  const nextAnalysisCache: Simplify2AnalysisCache = {
    ...analysisCache,
    updatedAt: nowIso(),
    focusHash: computeFocusHash(state),
    analysisFingerprint: state.analysisCache.analysisFingerprint ?? analysisCache.analysisFingerprint,
    lastAppliedHypothesisId: normalizedHypothesis.canonicalId ?? normalizedHypothesis.id,
    lastTouchedFiles: touchedFiles,
    overlapSuppression: [
      ...analysisCache.overlapSuppression.filter((candidate) =>
        candidate.hypothesisId !== (normalizedHypothesis.canonicalId ?? normalizedHypothesis.id)),
      entry,
    ].slice(-25),
  };
  writeJsonFile(requireArtifactPath(state.artifacts.analysisCachePath, "analysis cache"), nextAnalysisCache);
  return {
    ...state,
    analysisCache: {
      ...state.analysisCache,
      analysisFingerprint: nextAnalysisCache.analysisFingerprint,
    },
  };
}

function readCurrentObservationCache(
  state: Simplify2State,
  analysisFingerprint = state.analysisCache.analysisFingerprint ?? currentRepoAnalysisFingerprint(state),
): Simplify2ObservationCache {
  return readJsonFile(
    requireArtifactPath(state.artifacts.observationsPath, "observation cache"),
    Simplify2ObservationCacheType,
    createDefaultObservationCache(computeFocusHash(state), analysisFingerprint),
  );
}

function readCurrentAnalysisCache(state: Simplify2State): Simplify2AnalysisCache {
  return readJsonFile(
    requireArtifactPath(state.artifacts.analysisCachePath, "analysis cache"),
    Simplify2AnalysisCacheType,
    createDefaultAnalysisCache(
      computeFocusHash(state),
      state.analysisCache.analysisFingerprint ?? currentRepoAnalysisFingerprint(state),
    ),
  );
}

function planAnalysisReuse(state: Simplify2State): {
  analysisFingerprint: string;
  touchedFiles: string[];
  reusableEntries: Simplify2ObservationCacheEntry[];
  staleEntries: Simplify2ObservationCacheEntry[];
  shouldRunFullRefresh: boolean;
} {
  const analysisFingerprint = currentRepoAnalysisFingerprint(state);
  const focusHash = computeFocusHash(state);
  const observationCache = readCurrentObservationCache(state, analysisFingerprint);
  const analysisCache = readCurrentAnalysisCache(state);
  const touchedFiles = normalizePaths(state.notebook.latestApply?.result.touchedFiles ?? analysisCache.lastTouchedFiles);

  if (observationCache.focusHash !== focusHash || analysisCache.focusHash !== focusHash || observationCache.observations.length === 0) {
    return {
      analysisFingerprint,
      touchedFiles,
      reusableEntries: [],
      staleEntries: observationCache.observations,
      shouldRunFullRefresh: true,
    };
  }

  const touchedSet = new Set(touchedFiles);
  const reusableEntries: Simplify2ObservationCacheEntry[] = [];
  const staleEntries: Simplify2ObservationCacheEntry[] = [];
  for (const entry of observationCache.observations) {
    const isStale = touchedSet.size > 0 && entry.sourcePaths.some((path) => touchedSet.has(path));
    if (isStale) {
      staleEntries.push({ ...entry, stale: true });
      continue;
    }
    reusableEntries.push({ ...entry, stale: false });
  }

  const staleRatio = observationCache.observations.length === 0
    ? 1
    : staleEntries.length / observationCache.observations.length;
  const shouldRunFullRefresh = reusableEntries.length === 0
    || staleRatio > ANALYSIS_STALE_FULL_REFRESH_THRESHOLD
    || touchedFiles.some((path) => HIGH_SENSITIVITY_ANALYSIS_PATH_PATTERNS.some((pattern) => pattern.test(path)));

  const nextAnalysisCache: Simplify2AnalysisCache = {
    ...analysisCache,
    updatedAt: nowIso(),
    focusHash,
    analysisFingerprint,
    reusableObservationIds: reusableEntries.map((entry) => entry.observation.id),
    staleObservationIds: staleEntries.map((entry) => entry.observation.id),
  };
  writeJsonFile(requireArtifactPath(state.artifacts.analysisCachePath, "analysis cache"), nextAnalysisCache);

  return {
    analysisFingerprint,
    touchedFiles,
    reusableEntries,
    staleEntries,
    shouldRunFullRefresh,
  };
}

function currentRepoAnalysisFingerprint(state: Simplify2State): string {
  return computeRepoFingerprint({ cwd: requireArtifactPath(state.artifacts.repoRoot, "repo root") }).fingerprint;
}

function computeFocusHash(state: Simplify2State): string {
  return hashFocusPayload({
    originalPrompt: state.originalPrompt,
    scope: state.focus.scope,
    exclusions: state.focus.exclusions,
    goals: state.focus.goals,
    constraints: state.focus.constraints,
    guidance: state.focus.guidance,
  });
}

function computeCanonicalHypothesisId(hypothesis: SimplifyHypothesisDraft): string {
  const scopePaths = normalizePaths(hypothesis.implementationScope);
  const payload = {
    kind: hypothesis.kind,
    titleTokens: extractTokens(hypothesis.title),
    summaryTokens: extractTokens(hypothesis.summary),
    rationaleTokens: extractTokens(hypothesis.rationale),
    scopePaths,
    scopeTokens: uniqueStrings(scopePaths.flatMap((path) => extractTokens(path))),
    evidenceRefs: uniqueStrings(hypothesis.evidence.map((evidence) => `${evidence.kind}:${normalizePath(evidence.ref)}`)),
  };
  return `hyp-${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12)}`;
}

function getHypothesisSourceId(hypothesis: SimplifyHypothesis | SimplifyHypothesisDraft): string {
  return "sourceHypothesisId" in hypothesis && typeof hypothesis.sourceHypothesisId === "string" && hypothesis.sourceHypothesisId.trim().length > 0
    ? hypothesis.sourceHypothesisId
    : hypothesis.id;
}

function getHypothesisCanonicalId(hypothesis: SimplifyHypothesis | SimplifyHypothesisDraft): string {
  return "canonicalId" in hypothesis && typeof hypothesis.canonicalId === "string" && hypothesis.canonicalId.trim().length > 0
    ? hypothesis.canonicalId
    : computeCanonicalHypothesisId({
      ...hypothesis,
      id: getHypothesisSourceId(hypothesis),
    });
}

function withStableHypothesisIdentity(hypothesis: SimplifyHypothesis): SimplifyHypothesis {
  return {
    ...hypothesis,
    sourceHypothesisId: getHypothesisSourceId(hypothesis),
    canonicalId: getHypothesisCanonicalId(hypothesis),
  };
}

function hypothesisMatchesIdentifier(hypothesis: SimplifyHypothesis, hypothesisId: string | undefined): boolean {
  if (!hypothesisId) {
    return false;
  }
  return hypothesis.id === hypothesisId
    || getHypothesisSourceId(hypothesis) === hypothesisId
    || getHypothesisCanonicalId(hypothesis) === hypothesisId;
}

function resolveCanonicalHypothesisId(state: Simplify2State, hypothesisId?: string): string | undefined {
  if (!hypothesisId) {
    return undefined;
  }
  const checkpointId = state.notebook.currentCheckpoint?.hypothesisId;
  if (checkpointId === hypothesisId) {
    return checkpointId;
  }
  const candidate = state.notebook.candidateHypotheses
    .map((entry) => withStableHypothesisIdentity(entry))
    .find((entry) => hypothesisMatchesIdentifier(entry, hypothesisId));
  if (candidate) {
    return candidate.canonicalId ?? candidate.id;
  }
  const latestApply = state.notebook.latestApply;
  if (latestApply) {
    if (latestApply.hypothesisId === hypothesisId || latestApply.sourceHypothesisId === hypothesisId) {
      return latestApply.hypothesisId;
    }
  }
  return hypothesisId;
}

function normalizeResolvedHypothesisIds(state: Simplify2State, hypothesisIds: string[]): string[] {
  return hypothesisIds
    .map((hypothesisId) => resolveCanonicalHypothesisId(state, hypothesisId))
    .filter((hypothesisId): hypothesisId is string => typeof hypothesisId === "string" && hypothesisId.length > 0);
}

function hashFocusPayload(payload: {
  originalPrompt: string;
  scope: string[];
  exclusions: string[];
  goals: string[];
  constraints: string[];
  guidance: string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      originalPrompt: payload.originalPrompt.trim(),
      scope: normalizeStrings(payload.scope),
      exclusions: normalizeStrings(payload.exclusions),
      goals: normalizeStrings(payload.goals),
      constraints: normalizeStrings(payload.constraints),
      guidance: normalizeStrings(payload.guidance),
    }))
    .digest("hex")
    .slice(0, 12);
}

function deriveObservationSourcePaths(observation: SimplifyObservation): string[] {
  return normalizePaths(
    observation.evidence
      .filter((evidence) => evidence.kind === "file" || evidence.kind === "test" || evidence.kind === "doc")
      .map((evidence) => evidence.ref),
  );
}

function deriveObservationArtifacts(observation: SimplifyObservation): string[] {
  return uniqueStrings(observation.evidence.map((evidence) => evidence.kind));
}

function observationCacheKey(observation: SimplifyObservation): string {
  return `${observation.kind}\u0000${observation.summary.trim().toLowerCase()}`;
}

function findHighestHypothesisOverlap(
  hypothesis: SimplifyHypothesisDraft,
  priorEntries: Simplify2OverlapSuppressionEntry[],
): {
  entry: Simplify2OverlapSuppressionEntry;
  score: number;
  hasNoDistinctScope: boolean;
} | undefined {
  const scopePaths = normalizePaths(hypothesis.implementationScope);
  const titleTokens = extractTokens(hypothesis.title);
  const summaryTokens = extractTokens(hypothesis.summary);
  const scopeTokens = uniqueStrings(scopePaths.flatMap((path) => extractTokens(path)));
  const evidenceRefs = uniqueStrings(hypothesis.evidence.map((evidence) => normalizePath(evidence.ref)));
  let best:
    | {
      entry: Simplify2OverlapSuppressionEntry;
      score: number;
      hasNoDistinctScope: boolean;
    }
    | undefined;

  for (const entry of priorEntries) {
    const titleSimilarity = jaccardSimilarity(titleTokens, entry.titleTokens);
    const summarySimilarity = jaccardSimilarity(summaryTokens, entry.summaryTokens);
    const scopeOverlap = Math.max(
      jaccardSimilarity(scopeTokens, entry.normalizedScopeTokens),
      jaccardSimilarity(scopePaths, entry.touchedFiles),
    );
    const evidenceOverlap = jaccardSimilarity(evidenceRefs, entry.evidenceRefs);
    const score = (0.35 * titleSimilarity)
      + (0.25 * summarySimilarity)
      + (0.25 * scopeOverlap)
      + (0.15 * evidenceOverlap);
    const hasNoDistinctScope = scopePaths.length > 0 && scopePaths.every((path) => entry.touchedFiles.includes(path));
    if (!best || score > best.score) {
      best = { entry, score, hasNoDistinctScope };
    }
  }

  return best;
}

function jaccardSimilarity(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
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
  writeJsonFileAtomicSync(path, value);
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
void Simplify2ObservationCacheEntryType;
void Simplify2ObservationCacheType;
void Simplify2AnalysisCacheType;
void Simplify2FocusIndexEntryType;
void Simplify2FocusIndexType;
void Simplify2FocusMetadataType;
