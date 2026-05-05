import { registerActivityBarSegment, type ActivityBarSegment } from "./activity-bar.ts";
import { getCoreIdentitySegments } from "./core-activity-identity.ts";
import { formatElapsedRunTimer } from "../shared/format.ts";

/**
 * Core activity-bar segments. Registered for side effects when this module
 * is imported. Segment priority values reproduce the pre-migration drop
 * cascade byte-for-byte:
 *
 *   identity line default:   @provider • model-qualified • token (p+l)
 *   width short by one step: drop token percent        → @provider • model-qualified • token (limit only)
 *   width short by two:      drop token limit          → @provider • model-qualified • token (bare)
 *   width short by three:    drop @provider            → model-qualified • token (bare)
 *   width short by four:     drop model qualifier      → model-bare • token (bare)
 *
 * Priorities (lower is degraded first) and detailLevels encode that ladder:
 *   - token-usage: priority 0, detailLevels 2, droppable=false
 *   - agent:       priority 1, detailLevels 0, droppable=true
 *   - model:       priority 2, detailLevels 1, droppable=false
 */

const SEGMENTS: ActivityBarSegment[] = [
  ...getCoreIdentitySegments(),

  // Run-state line ----------------------------------------------------------
  {
    id: "runState.autoApprove",
    line: "runState",
    order: 0,
    shouldRender: (state) => state.simplify2AutoApprove,
    render: ({ theme }) => theme.success("approve on"),
  },
  {
    id: "runState.busy",
    line: "runState",
    order: 1,
    shouldRender: (state) => state.inputDisabled,
    render: ({ theme }) => theme.warning("● busy"),
  },
  {
    id: "runState.timer",
    line: "runState",
    order: 2,
    shouldRender: (state) => state.inputDisabledReason === "run" && state.runStartedAtMs !== undefined,
    render: ({ state, theme, nowMs }) => {
      if (state.runStartedAtMs === undefined) {
        return undefined;
      }
      return theme.warning(formatElapsedRunTimer(Math.max(0, nowMs - state.runStartedAtMs)));
    },
  },
  {
    id: "runState.activeProcedure",
    line: "runState",
    order: 3,
    shouldRender: (state) => state.activeProcedure !== undefined,
    render: ({ state, theme }) => theme.warning(`proc /${state.activeProcedure}`),
  },
  {
    id: "runState.continuation",
    line: "runState",
    order: 4,
    shouldRender: (state) => state.pendingContinuation !== undefined,
    render: ({ state, theme }) => {
      if (!state.pendingContinuation) {
        return undefined;
      }
      return theme.warning(`cont /${state.pendingContinuation.procedure}`);
    },
  },
  {
    id: "runState.steer",
    line: "runState",
    order: 5,
    shouldRender: (state) =>
      state.pendingPrompts.filter((prompt) => prompt.kind === "steering").length > 0,
    render: ({ state, theme }) => {
      const count = state.pendingPrompts.filter((prompt) => prompt.kind === "steering").length;
      return count > 0 ? theme.warning(`steer ${count}`) : undefined;
    },
  },
  {
    id: "runState.queued",
    line: "runState",
    order: 6,
    shouldRender: (state) =>
      state.pendingPrompts.filter((prompt) => prompt.kind === "queued").length > 0,
    render: ({ state, theme }) => {
      const count = state.pendingPrompts.filter((prompt) => prompt.kind === "queued").length;
      return count > 0 ? theme.warning(`queued ${count}`) : undefined;
    },
  },
];

for (const segment of SEGMENTS) {
  registerActivityBarSegment(segment);
}
