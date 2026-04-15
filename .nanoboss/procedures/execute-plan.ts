import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import typia from "typia";

import { expectData } from "../../src/core/run-result.ts";
import {
  jsonType,
  type DownstreamAgentSelection,
  type KernelValue,
  type Procedure,
  type ProcedureApi,
  type ProcedureResult,
  type RunRef,
} from "../../src/core/types.ts";

interface StepSelection {
  status: "continue" | "complete" | "blocked";
  rationale: string;
  completionSummary: string | null;
  blockerQuestion: string | null;
  stepId: string | null;
  stepIndex: number | null;
  stepTitle: string | null;
  stepGoal: string | null;
  stepInstructions: string[];
  successSignals: string[];
  commitContext: string | null;
}

interface StepExecutionResult {
  status: "completed" | "partial" | "blocked";
  summary: string;
  filesChanged: string[];
  verification: string[];
  blockers: string[];
  followupSuggestions: string[];
}

interface ResumeIntent {
  intent: "continue" | "question" | "stop";
  rationale: string;
  carryForwardNote: string | null;
  question: string | null;
}

interface PreCommitRepairResult {
  summary: string;
  filesChanged: string[];
}

interface ExecutePlanState {
  version: 1;
  planPath: string;
  extraInstructions: string;
  autoApprove: boolean;
  continuationNotes: string[];
  currentStepId: string | null;
  currentStepIndex: number | null;
  completedSteps: CompletedStepRecord[];
  lastCompletedStep: CompletedStepRecord | null;
}

interface CompletedStepRecord {
  stepId: string;
  stepIndex: number | null;
  stepTitle: string;
  stepGoal: string;
  status: "completed" | "partial" | "blocked" | "checks_failed";
  implementationSummary: string;
  filesChanged: string[];
  verification: string[];
  blockers: string[];
  followupSuggestions: string[];
  implementationRun: RunRef;
  implementationSessionId?: string;
  implementationAgentSelection?: DownstreamAgentSelection;
  preCommitRun?: RunRef;
  commitRun?: RunRef;
  commitSummary?: string;
  completedAt: string;
}

interface PreCommitOutcome {
  passed: boolean;
  run: RunRef;
}

const StepSelectionType = jsonType<StepSelection>(
  typia.json.schema<StepSelection>(),
  typia.createValidate<StepSelection>(),
);

const StepExecutionResultType = jsonType<StepExecutionResult>(
  typia.json.schema<StepExecutionResult>(),
  typia.createValidate<StepExecutionResult>(),
);

const ResumeIntentType = jsonType<ResumeIntent>(
  typia.json.schema<ResumeIntent>(),
  typia.createValidate<ResumeIntent>(),
);

const PreCommitRepairResultType = jsonType<PreCommitRepairResult>(
  typia.json.schema<PreCommitRepairResult>(),
  typia.createValidate<PreCommitRepairResult>(),
);

const ExecutePlanStateType = jsonType<ExecutePlanState>(
  typia.json.schema<ExecutePlanState>(),
  typia.createValidate<ExecutePlanState>(),
);

const MAX_AUTO_APPROVE_STEPS_PER_RUN = 8;
const MAX_PRE_COMMIT_REPAIR_ATTEMPTS = 3;
const MAX_NOTE_COUNT = 12;

export default {
  name: "execute-plan",
  description: "Execute one markdown plan step at a time with isolated worker sessions and resumable Q&A",
  inputHint: "<plan-path> [instructions]",
  async execute(prompt, ctx) {
    const parsed = await parseExecutePlanPrompt(prompt, ctx.cwd);
    if (!parsed.planPath) {
      return {
        display: "Provide a markdown plan path for /execute-plan.\n",
        summary: "execute-plan: missing plan path",
      };
    }

    if (!parsed.absolutePlanPath) {
      return {
        display: `Plan file not found: ${parsed.planPath}\n`,
        summary: `execute-plan: missing plan ${parsed.planPath}`,
      };
    }

    const state: ExecutePlanState = {
      version: 1,
      planPath: parsed.planPath,
      extraInstructions: parsed.extraInstructions,
      autoApprove: parsed.autoApprove,
      continuationNotes: [],
      currentStepId: null,
      currentStepIndex: null,
      completedSteps: [],
      lastCompletedStep: null,
    };

    return await orchestratePlan(state, ctx);
  },
  async resume(prompt, rawState, ctx) {
    const state = requireExecutePlanState(rawState);
    const reply = prompt.trim();

    if (isStopReply(reply)) {
      return buildStoppedResult(state, "Stopped by user.");
    }

    if (!state.lastCompletedStep) {
      const nextState = appendContinuationNote(state, reply);
      return await orchestratePlan(nextState, ctx);
    }

    const intentResult = await ctx.agent.run(
      buildResumeIntentPrompt(state, reply),
      ResumeIntentType,
      {
        session: "fresh",
        stream: false,
      },
    );
    const intent = expectData(intentResult, "Resume classifier returned no data");

    if (intent.intent === "stop") {
      return buildStoppedResult(state, intent.rationale.trim() || "Stopped by user.");
    }

    if (intent.intent === "continue") {
      const nextState = appendContinuationNote(
        state,
        intent.carryForwardNote?.trim() || reply,
      );
      return await orchestratePlan(nextState, ctx);
    }

    return await answerFollowUpQuestion(
      state,
      intent.question?.trim() || reply,
      ctx,
    );
  },
} satisfies Procedure;

async function orchestratePlan(
  initialState: ExecutePlanState,
  ctx: ProcedureApi,
): Promise<ProcedureResult> {
  const dirtyWorkspace = getDirtyWorkspaceEntries(ctx.cwd);
  if (dirtyWorkspace.length > 0) {
    return buildDirtyWorkspacePause(initialState, dirtyWorkspace);
  }

  let state = initialState;
  let stepsExecuted = 0;
  const maxStepsThisRun = state.autoApprove ? MAX_AUTO_APPROVE_STEPS_PER_RUN : 1;

  while (stepsExecuted < maxStepsThisRun) {
    ctx.assertNotCancelled();
    ctx.ui.status({
      procedure: "execute-plan",
      phase: "select",
      message: "Selecting the next plan step",
      iteration: `${stepsExecuted + 1}/${maxStepsThisRun}`,
      autoApprove: state.autoApprove,
    });

    const planContent = await readPlanFile(resolve(ctx.cwd, state.planPath));
    const decisionResult = await ctx.agent.run(
      buildStepSelectionPrompt(state, planContent),
      StepSelectionType,
      {
        session: "fresh",
        stream: false,
      },
    );
    const decision = expectData(decisionResult, "Step selector returned no data");

    if (decision.status === "complete") {
      return buildPlanCompleteResult(
        state,
        decision.completionSummary?.trim() || decision.rationale.trim() || "Plan complete.",
      );
    }

    if (decision.status === "blocked" || !hasSelectedStep(decision)) {
      return buildBlockedPause(state, decision);
    }

    ctx.ui.text(`Executing ${formatStepLabel(decision.stepId, decision.stepTitle)}...\n`);
    const record = await executeStep(state, decision, planContent, ctx);
    state = {
      ...state,
      currentStepId: record.stepId,
      currentStepIndex: record.stepIndex,
      completedSteps: [...state.completedSteps, record],
      lastCompletedStep: record,
    };
    stepsExecuted += 1;

    if (record.status !== "completed" || !record.commitRun && record.commitSummary === undefined) {
      return buildStepPause(state, record);
    }

    if (!state.autoApprove) {
      return buildStepPause(state, record);
    }

    ctx.ui.text(renderAutoApproveCheckpoint(record));
  }

  return buildAutoApproveLimitPause(state);
}

async function executeStep(
  state: ExecutePlanState,
  decision: StepSelection,
  planContent: string,
  ctx: ProcedureApi,
): Promise<CompletedStepRecord> {
  const implementationResult = await ctx.agent.run(
    buildImplementationPrompt(state, decision, planContent, ctx.cwd),
    StepExecutionResultType,
    {
      session: "fresh",
      stream: false,
    },
  );
  const implementation = expectData(implementationResult, "Implementation worker returned no data");

  const record: CompletedStepRecord = {
    stepId: decision.stepId?.trim() || `step-${state.completedSteps.length + 1}`,
    stepIndex: decision.stepIndex ?? null,
    stepTitle: decision.stepTitle?.trim() || "Untitled step",
    stepGoal: decision.stepGoal?.trim() || "",
    status: implementation.status,
    implementationSummary: implementation.summary.trim(),
    filesChanged: normalizeStrings(implementation.filesChanged),
    verification: normalizeStrings(implementation.verification),
    blockers: normalizeStrings(implementation.blockers),
    followupSuggestions: normalizeStrings(implementation.followupSuggestions),
    implementationRun: implementationResult.run,
    implementationSessionId: implementationResult.tokenUsage?.sessionId,
    implementationAgentSelection: implementationResult.defaultAgentSelection,
    completedAt: new Date().toISOString(),
  };

  if (implementation.status !== "completed") {
    return record;
  }

  ctx.ui.text("Running pre-commit checks...\n");
  const preCommitOutcome = await runPreCommitLoop(record, ctx);
  record.preCommitRun = preCommitOutcome.run;
  if (!preCommitOutcome.passed) {
    record.status = "checks_failed";
    return record;
  }

  const dirtyAfterChecks = getDirtyWorkspaceEntries(ctx.cwd);
  if (dirtyAfterChecks.length === 0) {
    record.commitSummary = "No commit was created because the step required no repository changes.";
    return record;
  }

  ctx.ui.text("Creating commit...\n");
  const commitResult = await ctx.procedures.run(
    "nanoboss/commit",
    decision.commitContext?.trim()
      || `Complete ${formatStepLabel(record.stepId, record.stepTitle)} from ${state.planPath}`,
  );
  record.commitRun = commitResult.run;
  record.commitSummary = await readDisplayRef(commitResult.displayRef, ctx)
    ?? commitResult.summary
    ?? "Commit created.";
  return record;
}

async function runPreCommitLoop(
  record: CompletedStepRecord,
  ctx: ProcedureApi,
): Promise<PreCommitOutcome> {
  let latest = await runPreCommitChecks(ctx, false);
  if (latest.passed) {
    return latest;
  }

  for (let attempt = 1; attempt <= MAX_PRE_COMMIT_REPAIR_ATTEMPTS; attempt += 1) {
    ctx.assertNotCancelled();
    ctx.ui.text(`Attempting pre-commit repair pass ${attempt}...\n`);

    await ctx.agent.run(
      buildPreCommitRepairPrompt(record, latest.run, attempt),
      PreCommitRepairResultType,
      {
        stream: false,
        ...(record.implementationSessionId
          ? { persistedSessionId: record.implementationSessionId }
          : { session: "fresh" as const }),
        ...(record.implementationAgentSelection
          ? { agent: record.implementationAgentSelection }
          : {}),
        refs: {
          implementationRun: record.implementationRun,
          checksRun: latest.run,
        },
      },
    );

    latest = await runPreCommitChecks(ctx, true);
    if (latest.passed) {
      return latest;
    }
  }

  return latest;
}

async function runPreCommitChecks(
  ctx: ProcedureApi,
  refresh: boolean,
): Promise<PreCommitOutcome> {
  const result = await ctx.procedures.run<{ passed: boolean }>(
    "nanoboss/pre-commit-checks",
    refresh ? "--refresh" : "",
  );
  const checks = expectData(result, "Pre-commit checks returned no data");
  return {
    passed: checks.passed === true,
    run: result.run,
  };
}

async function answerFollowUpQuestion(
  state: ExecutePlanState,
  question: string,
  ctx: ProcedureApi,
): Promise<ProcedureResult> {
  const lastStep = state.lastCompletedStep;
  if (!lastStep) {
    const nextState = appendContinuationNote(state, question);
    return await orchestratePlan(nextState, ctx);
  }

  ctx.ui.text("Answering your follow-up using the implementation context...\n");
  const answerResult = await ctx.agent.run(
    buildFollowUpQuestionPrompt(state, question),
    {
      stream: false,
      ...(lastStep.implementationSessionId
        ? { persistedSessionId: lastStep.implementationSessionId }
        : { session: "fresh" as const }),
      ...(lastStep.implementationAgentSelection
        ? { agent: lastStep.implementationAgentSelection }
        : {}),
      refs: buildLastStepRefs(lastStep),
    },
  );
  const answer = typeof answerResult.data === "string" ? answerResult.data.trim() : "";

  return {
    data: buildResultData(state),
    display: [
      answer || "No answer returned.",
      "",
      renderStepReport(lastStep),
    ].join("\n"),
    summary: `execute-plan: answered question about ${formatStepLabel(lastStep.stepId, lastStep.stepTitle)}`,
    pause: buildContinuationPause(state),
  };
}

async function parseExecutePlanPrompt(
  prompt: string,
  cwd: string,
): Promise<{
  planPath?: string;
  absolutePlanPath?: string;
  extraInstructions: string;
  autoApprove: boolean;
}> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return {
      extraInstructions: "",
      autoApprove: false,
    };
  }

  const tokens = tokenizePrompt(trimmed);
  for (let length = tokens.length; length >= 1; length -= 1) {
    const candidate = tokens.slice(0, length).join(" ").trim();
    const resolvedPath = await resolvePlanPath(candidate, cwd);
    if (!resolvedPath) {
      continue;
    }

    const extraInstructions = tokens.slice(length).join(" ").trim();
    return {
      planPath: resolvedPath.displayPath,
      absolutePlanPath: resolvedPath.absolutePath,
      extraInstructions,
      autoApprove: inferAutoApprove(extraInstructions),
    };
  }

  const [firstToken = ""] = tokens;
  return {
    planPath: firstToken || undefined,
    extraInstructions: tokens.slice(1).join(" ").trim(),
    autoApprove: inferAutoApprove(tokens.slice(1).join(" ").trim()),
  };
}

async function resolvePlanPath(
  candidate: string,
  cwd: string,
): Promise<{ absolutePath: string; displayPath: string } | undefined> {
  const raw = candidate.trim();
  if (!raw) {
    return undefined;
  }

  const variants = raw.endsWith(".md") ? [raw] : [raw, `${raw}.md`];
  for (const variant of variants) {
    const absolutePath = isAbsolute(variant) ? variant : resolve(cwd, variant);
    if (!(await isRegularFile(absolutePath))) {
      continue;
    }

    return {
      absolutePath,
      displayPath: toDisplayPath(absolutePath, cwd),
    };
  }

  return undefined;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    return entry.isFile();
  } catch {
    return false;
  }
}

async function readPlanFile(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

function buildStepSelectionPrompt(state: ExecutePlanState, planContent: string): string {
  return [
    "You are selecting the single next actionable step from a markdown execution plan.",
    "Read the plan carefully and decide whether the plan is complete, blocked, or ready for one next step.",
    "Respect explicit operator instructions such as starting from a specific step.",
    "Return a JSON object with exactly these fields:",
    "`status`, `rationale`, `completionSummary`, `blockerQuestion`, `stepId`, `stepIndex`, `stepTitle`, `stepGoal`, `stepInstructions`, `successSignals`, and `commitContext`.",
    "Rules:",
    "- Choose exactly one next step when `status` is `continue`.",
    "- Prefer the next unfinished concrete step from the plan unless operator notes say otherwise.",
    "- Treat previously completed steps as done unless the notes clearly ask you to revisit one.",
    "- When `status` is `complete`, set all next-step fields to null or empty arrays.",
    "- When `status` is `blocked`, explain why and provide a concise blocker question.",
    "- `commitContext` should be a short commit intent for this one step only.",
    "- Return no prose outside the JSON object.",
    "",
    `Plan path: ${state.planPath}`,
    "",
    "Operator instructions:",
    ...renderListOrNone(renderOperatorNotes(state)),
    "",
    "Previously completed steps:",
    ...renderListOrNone(summarizeCompletedSteps(state.completedSteps)),
    "",
    "Plan markdown:",
    planContent,
  ].join("\n");
}

function buildImplementationPrompt(
  state: ExecutePlanState,
  decision: StepSelection,
  planContent: string,
  cwd: string,
): string {
  return [
    `You are implementing exactly one plan step in the repository at ${cwd}.`,
    "You are running in a fresh isolated session for this step.",
    "Inspect the repository as needed and make the smallest coherent set of changes for the selected step.",
    "Run focused validation appropriate to this step.",
    "Do not run the repo-wide pre-commit command; the caller will handle that.",
    "Do not create a commit.",
    "Return a JSON object with exactly these fields: `status`, `summary`, `filesChanged`, `verification`, `blockers`, and `followupSuggestions`.",
    "`status` must be one of `completed`, `partial`, or `blocked`.",
    "Return no prose outside the JSON object.",
    "",
    `Plan path: ${state.planPath}`,
    `Overall extra instructions: ${state.extraInstructions || "none"}`,
    "",
    `Selected step: ${formatStepLabel(decision.stepId, decision.stepTitle)}`,
    `Step index: ${decision.stepIndex ?? "unknown"}`,
    `Step goal: ${decision.stepGoal ?? "n/a"}`,
    "",
    "Step instructions:",
    ...renderNumberedList(decision.stepInstructions),
    "",
    "Success signals:",
    ...renderListOrNone(decision.successSignals),
    "",
    "Previously completed steps:",
    ...renderListOrNone(summarizeCompletedSteps(state.completedSteps)),
    "",
    "Plan markdown:",
    planContent,
  ].join("\n");
}

function buildPreCommitRepairPrompt(
  record: CompletedStepRecord,
  checksRun: RunRef,
  attempt: number,
): string {
  return [
    "You are repairing remaining pre-commit check failures for the step you just implemented.",
    "You may inspect the durable refs `implementationRun` and `checksRun`.",
    "Continue from the existing implementation session if one is available.",
    `Current step: ${formatStepLabel(record.stepId, record.stepTitle)}`,
    `Attempt: ${attempt}`,
    "Fix only the remaining failures reported by `checksRun`.",
    "Do not create a commit.",
    "Return a JSON object with exactly these fields: `summary` and `filesChanged`.",
    "Return no prose outside the JSON object.",
    "",
    `Step goal: ${record.stepGoal || "n/a"}`,
    `Implementation summary: ${record.implementationSummary || "n/a"}`,
    `Checks run ref: ${checksRun.runId}`,
  ].join("\n");
}

function buildResumeIntentPrompt(state: ExecutePlanState, reply: string): string {
  const lastStep = state.lastCompletedStep;
  return [
    "Classify the user's continuation reply for a plan executor.",
    "Decide whether the user wants to proceed to the next plan step now, ask a follow-up question about the completed work, or stop.",
    "Return a JSON object with exactly these fields: `intent`, `rationale`, `carryForwardNote`, and `question`.",
    "Rules:",
    "- `intent` must be one of `continue`, `question`, or `stop`.",
    "- Use `continue` when the user is approving the next step, even if they add extra steering instructions.",
    "- Use `question` when the user is asking about the completed work or requesting explanation.",
    "- Use `stop` only for explicit stop/cancel/abort instructions.",
    "- If `intent` is `continue`, put any useful extra steering in `carryForwardNote`; otherwise set it to null.",
    "- If `intent` is `question`, rewrite the user's question in `question`; otherwise set it to null.",
    "- When uncertain, prefer `question` over `continue`.",
    "- Return no prose outside the JSON object.",
    "",
    `Plan path: ${state.planPath}`,
    lastStep
      ? `Last completed step: ${formatStepLabel(lastStep.stepId, lastStep.stepTitle)}`
      : "Last completed step: none",
    lastStep ? `Last step summary: ${lastStep.implementationSummary || "n/a"}` : undefined,
    "",
    `User reply: ${reply}`,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function buildFollowUpQuestionPrompt(state: ExecutePlanState, question: string): string {
  const lastStep = state.lastCompletedStep;
  return [
    "Answer the user's follow-up question about the work you just completed.",
    "Respond directly and precisely.",
    "You may inspect the repository if needed.",
    lastStep
      ? `The relevant completed step was ${formatStepLabel(lastStep.stepId, lastStep.stepTitle)}.`
      : undefined,
    `Plan path: ${state.planPath}`,
    `User question: ${question}`,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function buildStepPause(state: ExecutePlanState, record: CompletedStepRecord): ProcedureResult {
  const display = renderStepReport(record);
  return {
    data: buildResultData(state),
    display,
    summary: `execute-plan: ${record.status} ${formatStepLabel(record.stepId, record.stepTitle)}`,
    memory: buildMemory(state, record),
    pause: buildContinuationPause(state),
  };
}

function buildBlockedPause(
  state: ExecutePlanState,
  decision: StepSelection,
): ProcedureResult {
  return {
    data: buildResultData(state),
    display: [
      `Execution is blocked for plan ${state.planPath}.`,
      decision.rationale.trim() || "The next step could not be selected autonomously.",
      "",
      "Completed steps so far:",
      ...renderListOrNone(summarizeCompletedSteps(state.completedSteps)),
    ].join("\n"),
    summary: `execute-plan: blocked for ${state.planPath}`,
    pause: {
      question: decision.blockerQuestion?.trim()
        || "What should I change before I continue with this plan?",
      state,
      inputHint: "Clarify the plan, answer the blocker, or say stop",
      suggestedReplies: [
        "Continue",
        "Ask a question",
        "Stop",
      ],
    },
  };
}

function buildDirtyWorkspacePause(
  state: ExecutePlanState,
  dirtyEntries: string[],
): ProcedureResult {
  return {
    data: buildResultData(state),
    display: [
      "The workspace already has uncommitted changes, so /execute-plan cannot safely create a one-step commit yet.",
      "",
      "Dirty entries:",
      ...dirtyEntries.map((entry) => `- ${entry}`),
    ].join("\n"),
    summary: `execute-plan: dirty workspace before ${state.planPath}`,
    pause: {
      question: "Clean up or commit the existing changes, then reply continue when the workspace is ready.",
      state,
      inputHint: "Reply continue after the workspace is clean, or say stop",
      suggestedReplies: [
        "Continue",
        "Stop",
      ],
    },
  };
}

function buildPlanCompleteResult(
  state: ExecutePlanState,
  completionSummary: string,
): ProcedureResult {
  return {
    data: buildResultData(state),
    display: [
      `Plan complete: ${state.planPath}`,
      completionSummary,
      "",
      "Completed steps:",
      ...renderListOrNone(summarizeCompletedSteps(state.completedSteps)),
    ].join("\n"),
    summary: `execute-plan: complete ${state.planPath}`,
    memory: state.lastCompletedStep
      ? buildMemory(state, state.lastCompletedStep)
      : `execute-plan completed ${state.planPath}.`,
  };
}

function buildAutoApproveLimitPause(state: ExecutePlanState): ProcedureResult {
  return {
    data: buildResultData(state),
    display: [
      `Paused ${state.planPath} after ${MAX_AUTO_APPROVE_STEPS_PER_RUN} auto-approved steps in one run.`,
      "Review the latest result or reply continue to keep going.",
      "",
      state.lastCompletedStep ? renderStepReport(state.lastCompletedStep) : "No step was completed.",
    ].join("\n"),
    summary: `execute-plan: auto-approve limit for ${state.planPath}`,
    pause: buildContinuationPause(state),
  };
}

function buildStoppedResult(state: ExecutePlanState, reason: string): ProcedureResult {
  return {
    data: buildResultData(state),
    display: [
      `Stopped /execute-plan for ${state.planPath}.`,
      reason,
      "",
      state.lastCompletedStep ? renderStepReport(state.lastCompletedStep) : "No step was completed in the active continuation.",
    ].join("\n"),
    summary: `execute-plan: stopped for ${state.planPath}`,
    memory: `execute-plan stopped for ${state.planPath}. Reason: ${reason}`,
  };
}

function buildContinuationPause(state: ExecutePlanState) {
  return {
    question: "Ask a question about the completed work, reply continue to execute the next plan step, or say stop.",
    state,
    inputHint: "Ask a question, continue, or stop",
    suggestedReplies: [
      "Continue",
      "What changed?",
      "Stop",
    ],
  } satisfies NonNullable<ProcedureResult["pause"]>;
}

function buildResultData(state: ExecutePlanState): KernelValue {
  return {
    planPath: state.planPath,
    autoApprove: state.autoApprove,
    currentStepId: state.currentStepId,
    currentStepIndex: state.currentStepIndex,
    completedSteps: state.completedSteps.map((step) => ({
      stepId: step.stepId,
      stepIndex: step.stepIndex,
      stepTitle: step.stepTitle,
      status: step.status,
      implementationRun: step.implementationRun,
      preCommitRun: step.preCommitRun,
      commitRun: step.commitRun,
    })),
  };
}

function buildMemory(state: ExecutePlanState, record: CompletedStepRecord): string {
  const commit = record.commitSummary?.trim()
    ? ` Commit: ${singleLine(record.commitSummary)}.`
    : "";
  return `execute-plan ${record.status} ${formatStepLabel(record.stepId, record.stepTitle)} from ${state.planPath}. Summary: ${singleLine(record.implementationSummary) || "n/a"}.${commit}`;
}

function buildLastStepRefs(record: CompletedStepRecord): Record<string, RunRef> {
  return {
    implementationRun: record.implementationRun,
    ...(record.preCommitRun ? { preCommitRun: record.preCommitRun } : {}),
    ...(record.commitRun ? { commitRun: record.commitRun } : {}),
  };
}

async function readDisplayRef(
  displayRef: { path: string; run: RunRef } | undefined,
  ctx: ProcedureApi,
): Promise<string | undefined> {
  if (!displayRef) {
    return undefined;
  }

  const value = await ctx.state.refs.read<string>(displayRef);
  return typeof value === "string" ? value.trim() : undefined;
}

function requireExecutePlanState(value: KernelValue): ExecutePlanState {
  if (!ExecutePlanStateType.validate(value)) {
    throw new Error("Invalid execute-plan continuation state");
  }

  return value;
}

function appendContinuationNote(state: ExecutePlanState, note: string): ExecutePlanState {
  const trimmed = note.trim();
  if (!trimmed || isTrivialContinueReply(trimmed)) {
    return state;
  }

  return {
    ...state,
    continuationNotes: normalizeStrings([...state.continuationNotes, trimmed]).slice(-MAX_NOTE_COUNT),
  };
}

function renderStepReport(record: CompletedStepRecord): string {
  const lines = [
    `Step result: ${formatStepLabel(record.stepId, record.stepTitle)}.`,
    `Status: ${record.status}.`,
    `Summary: ${record.implementationSummary || "n/a"}`,
    record.filesChanged.length > 0
      ? `Files changed: ${record.filesChanged.join(", ")}`
      : "Files changed: none reported",
    record.verification.length > 0
      ? `Verification: ${record.verification.join("; ")}`
      : "Verification: none reported",
  ];

  if (record.blockers.length > 0) {
    lines.push(`Blockers: ${record.blockers.join("; ")}`);
  }

  if (record.commitSummary?.trim()) {
    lines.push(`Commit: ${singleLine(record.commitSummary)}`);
  } else if (record.status === "checks_failed") {
    lines.push("Commit: not created because pre-commit checks still fail.");
  } else if (record.status !== "completed") {
    lines.push("Commit: not created because the step did not finish cleanly.");
  }

  return `${lines.join("\n")}\n`;
}

function renderAutoApproveCheckpoint(record: CompletedStepRecord): string {
  return [
    `Auto-approved checkpoint: ${formatStepLabel(record.stepId, record.stepTitle)} finished with status ${record.status}.`,
    record.commitSummary?.trim()
      ? `${singleLine(record.commitSummary)}`
      : record.status === "checks_failed"
        ? "Pre-commit checks still fail; pausing."
        : "Proceeding to the next step.",
    "",
  ].join("\n");
}

function summarizeCompletedSteps(steps: CompletedStepRecord[]): string[] {
  return steps.map((step) => {
    const summary = step.implementationSummary ? `: ${singleLine(step.implementationSummary)}` : "";
    return `${formatStepLabel(step.stepId, step.stepTitle)} [${step.status}]${summary}`;
  });
}

function renderOperatorNotes(state: ExecutePlanState): string[] {
  return normalizeStrings([
    state.extraInstructions,
    ...state.continuationNotes,
  ]);
}

function formatStepLabel(stepId: string | null | undefined, stepTitle: string | null | undefined): string {
  if (stepId?.trim() && stepTitle?.trim()) {
    return `${stepId.trim()} ${stepTitle.trim()}`;
  }

  if (stepTitle?.trim()) {
    return stepTitle.trim();
  }

  if (stepId?.trim()) {
    return stepId.trim();
  }

  return "unnamed step";
}

function hasSelectedStep(decision: StepSelection): boolean {
  return Boolean(
    decision.stepTitle?.trim()
      || decision.stepGoal?.trim()
      || decision.stepId?.trim(),
  ) && decision.stepInstructions.length > 0;
}

function inferAutoApprove(extraInstructions: string): boolean {
  const normalized = extraInstructions.toLowerCase();
  return normalized.includes("auto-approve")
    || normalized.includes("auto approve")
    || normalized.includes("automatically continue")
    || normalized.includes("continue automatically")
    || normalized.includes("run all steps")
    || normalized.includes("keep going automatically");
}

function tokenizePrompt(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);
    if ((char === "\"" || char === "'") && quote === null) {
      quote = char;
      continue;
    }

    if (quote && char === quote) {
      quote = null;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function isStopReply(reply: string): boolean {
  return /^(stop|cancel|abort|quit)$/i.test(reply.trim());
}

function isTrivialContinueReply(reply: string): boolean {
  return /^(continue|next|proceed|go ahead|yes|y)$/i.test(reply.trim());
}

function normalizeStrings(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function renderListOrNone(values: readonly string[]): string[] {
  return values.length > 0 ? [...values] : ["- none"];
}

function renderNumberedList(values: readonly string[]): string[] {
  if (values.length === 0) {
    return ["1. No explicit instructions provided."];
  }

  return values.map((value, index) => `${index + 1}. ${value}`);
}

function getDirtyWorkspaceEntries(cwd: string): string[] {
  const output = execGit(cwd, ["status", "--short"]);
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function execGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
    });
  } catch {
    return "";
  }
}

function toDisplayPath(absolutePath: string, cwd: string): string {
  const relativePath = relative(cwd, absolutePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return absolutePath;
  }

  return relativePath;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
