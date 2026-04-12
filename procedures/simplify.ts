import typia from "typia";

import { expectData } from "../src/core/run-result.ts";
import {
  jsonType,
  type ProcedureApi,
  type KernelValue,
  type Procedure,
  type ProcedureResult,
} from "../src/core/types.ts";

interface SimplifyOpportunity {
  stop: boolean;
  stopReason?: string;
  title: string;
  summary: string;
  rationale: string;
  files: string[];
  instructions: string;
}

interface SimplifyDecision {
  action: "apply" | "skip" | "stop";
  rationale: string;
  guidance?: string;
}

interface SimplifyApplyResult {
  summary: string;
  touchedFiles: string[];
}

interface SimplifyHistoryEntry {
  title: string;
  outcome: "applied" | "skipped";
  note?: string;
}

interface SimplifyState {
  originalPrompt: string;
  notes: string[];
  iteration: number;
  currentOpportunity: SimplifyOpportunity;
  history: SimplifyHistoryEntry[];
}

const SimplifyOpportunityType = jsonType<SimplifyOpportunity>(
  typia.json.schema<SimplifyOpportunity>(),
  typia.createValidate<SimplifyOpportunity>(),
);

const SimplifyDecisionType = jsonType<SimplifyDecision>(
  typia.json.schema<SimplifyDecision>(),
  typia.createValidate<SimplifyDecision>(),
);

const SimplifyApplyResultType = jsonType<SimplifyApplyResult>(
  typia.json.schema<SimplifyApplyResult>(),
  typia.createValidate<SimplifyApplyResult>(),
);

const SimplifyStateType = jsonType<SimplifyState>(
  typia.json.schema<SimplifyState>(),
  typia.createValidate<SimplifyState>(),
);

const DEFAULT_FOCUS = "simplify the current project";
const SUGGESTED_REPLIES = [
  "apply it",
  "skip it",
  "stop",
  "look for dead code instead",
  "focus on duplicate code",
];

export default {
  name: "simplify",
  description: "Find and apply simplifications one opportunity at a time",
  inputHint: "Optional focus or scope",
  executionMode: "harness",
  async execute(prompt, ctx) {
    const focus = prompt.trim() || DEFAULT_FOCUS;
    ctx.ui.text("Scanning the repository for a simplification opportunity...\n");

    const opportunity = await findNextOpportunity({
      focus,
      notes: [],
      history: [],
      ctx,
    });
    if (opportunity.stop) {
      return buildFinishedResult({
        focus,
        history: [],
        reason: opportunity.stopReason ?? "No worthwhile simplification opportunity stood out.",
      });
    }

    const state: SimplifyState = {
      originalPrompt: focus,
      notes: [],
      iteration: 1,
      currentOpportunity: opportunity,
      history: [],
    };

    return buildPausedResult({
      state,
      lead: "I found one simplification opportunity.",
    });
  },
  async resume(prompt, stateValue, ctx) {
    const state = requireSimplifyState(stateValue);
    const reply = prompt.trim();
    ctx.ui.text(`Interpreting your feedback for simplify iteration ${state.iteration}...\n`);

    const decision = await interpretDecision({
      reply,
      state,
      ctx,
    });
    if (decision.action === "stop") {
      return buildFinishedResult({
        focus: state.originalPrompt,
        history: state.history,
        reason: decision.rationale,
      });
    }

    const notes = normalizeNotes(
      decision.guidance ? [...state.notes, decision.guidance] : state.notes,
    );
    let history: SimplifyHistoryEntry[];
    let lead: string;

    if (decision.action === "apply") {
      ctx.ui.text(`Applying simplify iteration ${state.iteration}...\n`);
      const applied = await applyOpportunity({
        opportunity: state.currentOpportunity,
        guidance: decision.guidance,
        focus: state.originalPrompt,
        ctx,
      });
      history = [
        ...state.history,
        {
          title: state.currentOpportunity.title,
          outcome: "applied",
          ...(decision.guidance ? { note: decision.guidance } : {}),
        },
      ];
      lead = [
        `Applied: ${state.currentOpportunity.title}.`,
        applied.summary.trim(),
        renderTouchedFiles(applied.touchedFiles),
      ].filter(Boolean).join("\n");
    } else {
      history = [
        ...state.history,
        {
          title: state.currentOpportunity.title,
          outcome: "skipped",
          ...((decision.guidance ?? decision.rationale)
            ? { note: decision.guidance ?? decision.rationale }
            : {}),
        },
      ];
      lead = [
        `Skipped: ${state.currentOpportunity.title}.`,
        decision.rationale.trim(),
        decision.guidance ? `Future direction: ${decision.guidance.trim()}` : undefined,
      ].filter(Boolean).join("\n");
    }

    ctx.ui.text("Looking for the next simplification opportunity...\n");
    const nextOpportunity = await findNextOpportunity({
      focus: state.originalPrompt,
      notes,
      history,
      ctx,
    });
    if (nextOpportunity.stop) {
      return buildFinishedResult({
        focus: state.originalPrompt,
        history,
        reason: nextOpportunity.stopReason ?? "No further worthwhile simplification opportunity stood out.",
        lead,
      });
    }

    return buildPausedResult({
      state: {
        originalPrompt: state.originalPrompt,
        notes,
        iteration: state.iteration + 1,
        currentOpportunity: nextOpportunity,
        history,
      },
      lead,
    });
  },
} satisfies Procedure;

async function findNextOpportunity(params: {
  focus: string;
  notes: string[];
  history: SimplifyHistoryEntry[];
  ctx: ProcedureApi;
}): Promise<SimplifyOpportunity> {
  const historyLines = params.history.length > 0
    ? params.history.map((entry) => `- ${entry.title}: ${entry.outcome}${entry.note ? ` (${entry.note})` : ""}`)
    : ["- none"];
  const noteLines = params.notes.length > 0
    ? params.notes.map((note) => `- ${note}`)
    : ["- none"];
  const result = await params.ctx.agent.run(
    [
      "You are scanning the current repository for one worthwhile simplification opportunity.",
      "Prioritize: removing unnecessary abstractions, deduplicating logic, deleting obsolete or unused code, and removing backward-compatibility shims that no longer matter.",
      "Prefer one concrete small-to-medium change over broad rewrites.",
      "Return JSON only.",
      "If there is no worthwhile next opportunity, set `stop=true` and explain why in `stopReason`.",
      "Otherwise set `stop=false` and fill in `title`, `summary`, `rationale`, `files`, and `instructions`.",
      "Keep `files` narrowly scoped and `instructions` directly actionable.",
      "",
      `Requested focus: ${params.focus}`,
      `Accumulated guidance:\n${noteLines.join("\n")}`,
      `Previously reviewed opportunities:\n${historyLines.join("\n")}`,
    ].join("\n"),
    SimplifyOpportunityType,
    { stream: false },
  );
  return expectData(result, "Simplify opportunity scan returned no data");
}

async function interpretDecision(params: {
  reply: string;
  state: SimplifyState;
  ctx: ProcedureApi;
}): Promise<SimplifyDecision> {
  const result = await params.ctx.agent.run(
    [
      "Interpret the user's reply about the current simplification opportunity.",
      "Return JSON only.",
      "Allowed actions: `apply`, `skip`, `stop`.",
      "Use `apply` when the user broadly approves the current idea, even if they add constraints.",
      "Use `skip` when the user wants a different opportunity, a different area, or a different kind of simplification.",
      "Use `stop` when the user wants to end the loop.",
      "Put durable future guidance into `guidance` when useful.",
      "",
      `Overall focus: ${params.state.originalPrompt}`,
      `Current opportunity title: ${params.state.currentOpportunity.title}`,
      `Current opportunity summary: ${params.state.currentOpportunity.summary}`,
      `Current opportunity rationale: ${params.state.currentOpportunity.rationale}`,
      `Current opportunity files: ${params.state.currentOpportunity.files.join(", ") || "(unspecified)"}`,
      `Current accumulated guidance: ${params.state.notes.join(" | ") || "(none)"}`,
      "",
      `User reply: ${params.reply || "(empty)"}`,
    ].join("\n"),
    SimplifyDecisionType,
    { stream: false },
  );
  return expectData(result, "Simplify decision returned no data");
}

async function applyOpportunity(params: {
  opportunity: SimplifyOpportunity;
  guidance?: string;
  focus: string;
  ctx: ProcedureApi;
}): Promise<SimplifyApplyResult> {
  const result = await params.ctx.agent.run(
    [
      "Apply the following simplification directly in the repository.",
      "Prefer deleting, inlining, or consolidating code over adding new abstraction layers.",
      "Commit your work once you have validated the change locally.",
      "Return JSON only with `summary` and `touchedFiles`.",
      "",
      `Overall focus: ${params.focus}`,
      `Opportunity title: ${params.opportunity.title}`,
      `Opportunity summary: ${params.opportunity.summary}`,
      `Rationale: ${params.opportunity.rationale}`,
      `Files in scope: ${params.opportunity.files.join(", ") || "(unspecified)"}`,
      params.guidance ? `Additional user guidance: ${params.guidance}` : "Additional user guidance: none",
      `Implementation instructions:\n${params.opportunity.instructions}`,
    ].join("\n"),
    SimplifyApplyResultType,
    { stream: false },
  );
  return expectData(result, "Simplify apply step returned no data");
}

function buildPausedResult(params: {
  state: SimplifyState;
  lead?: string;
}): ProcedureResult {
  return {
    display: [
      params.lead,
      renderOpportunity(params.state.currentOpportunity, params.state.iteration),
      buildQuestion(params.state.currentOpportunity),
    ].filter(Boolean).join("\n\n") + "\n",
    summary: `simplify: paused on ${params.state.currentOpportunity.title}`,
    memory: `Simplify is paused on "${params.state.currentOpportunity.title}".`,
    pause: {
      question: buildQuestion(params.state.currentOpportunity),
      state: params.state,
      inputHint: "Reply with what you want: apply it, skip it, stop, or redirect the search",
      suggestedReplies: SUGGESTED_REPLIES,
    },
  };
}

function buildFinishedResult(params: {
  focus: string;
  history: SimplifyHistoryEntry[];
  reason: string;
  lead?: string;
}): ProcedureResult {
  return {
    data: {
      focus: params.focus,
      reviewedCount: params.history.length,
      appliedCount: params.history.filter((entry) => entry.outcome === "applied").length,
    },
    display: [
      params.lead,
      "Simplify is done for now.",
      `Reason: ${params.reason}`,
      `Reviewed opportunities: ${params.history.length}.`,
      `Applied opportunities: ${params.history.filter((entry) => entry.outcome === "applied").length}.`,
    ].filter(Boolean).join("\n") + "\n",
    summary: `simplify: finished after ${params.history.length} review${params.history.length === 1 ? "" : "s"}`,
    memory: `Simplify finished after ${params.history.length} reviewed opportunities.`,
  };
}

function buildQuestion(opportunity: SimplifyOpportunity): string {
  return `What would you like to do with "${opportunity.title}"? You can ask me to apply it, skip it, stop, or tell me what you want instead.`;
}

function renderOpportunity(opportunity: SimplifyOpportunity, iteration: number): string {
  return [
    `Simplify iteration ${iteration}: ${opportunity.title}`,
    opportunity.summary.trim(),
    `Why this helps: ${opportunity.rationale.trim()}`,
    renderFiles(opportunity.files),
  ].filter(Boolean).join("\n");
}

function renderFiles(files: string[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }

  return `Files: ${files.join(", ")}`;
}

function renderTouchedFiles(files: string[]): string | undefined {
  const normalized = normalizeFiles(files);
  return normalized.length > 0 ? `Touched files: ${normalized.join(", ")}` : undefined;
}

function normalizeFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter((file) => file.length > 0))];
}

function normalizeNotes(notes: string[]): string[] {
  return [...new Set(notes.map((note) => note.trim()).filter((note) => note.length > 0))];
}

function requireSimplifyState(value: KernelValue): SimplifyState {
  if (SimplifyStateType.validate(value)) {
    return value;
  }

  throw new Error("Invalid simplify continuation state.");
}
