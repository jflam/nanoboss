import { describe, expect, test } from "bun:test";

import {
  createInitialUiState,
  createNanobossTuiTheme,
} from "@nanoboss/adapters-tui";
import {
  buildActivityBarLine,
  registerActivityBarSegment,
  type ActivityBarSegment,
} from "../src/core/activity-bar.ts";

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(27);
  let result = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === esc && text.charAt(i + 1) === "[") {
      let cursor = i + 2;
      while (cursor < text.length) {
        const code = text.charCodeAt(cursor);
        if ((code < 48 || code > 57) && code !== 59) break;
        cursor += 1;
      }
      if (text.charAt(cursor) === "m") {
        i = cursor;
        continue;
      }
    }
    result += ch;
  }
  return result;
}

describe("activity-bar registry", () => {
  test("core segments are registered on both identity and runState lines", () => {
    const theme = createNanobossTuiTheme();
    const sep = theme.dim(" • ");
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
      tokenUsage: { used: 10_000, limit: 100_000, percent: 10 },
      defaultAgentSelection: { provider: "codex" as const, model: "gpt-5.4" },
      agentLabel: "codex/gpt-5.4",
      simplify2AutoApprove: true,
      inputDisabled: true,
      inputDisabledReason: "run" as const,
      runStartedAtMs: 0,
      activeProcedure: "demo",
      pendingContinuation: { procedure: "simplify", question: "choose" },
      pendingPrompts: [
        { id: "steer-1", text: "revise", kind: "steering" as const },
        { id: "queued-1", text: "next", kind: "queued" as const },
      ],
    };

    const identityLine = stripAnsi(buildActivityBarLine("identity", state, theme, 5_000, sep) ?? "");
    expect(identityLine).toContain("@codex");
    expect(identityLine).toContain("gpt-5.4");
    expect(identityLine).toContain("tok 10k/100k");

    const runStateLine = stripAnsi(buildActivityBarLine("runState", state, theme, 5_000, sep) ?? "");
    expect(runStateLine).toContain("approve on");
    expect(runStateLine).toContain("busy");
    expect(runStateLine).toContain("demo");
    expect(runStateLine).toContain("simplify");
    expect(runStateLine).toContain("steer");
    expect(runStateLine).toContain("queued");
  });

  test("registerActivityBarSegment rejects duplicate ids", () => {
    const duplicate: ActivityBarSegment = {
      id: "identity.agent",
      line: "identity",
      render: () => "@dup",
    };
    expect(() => registerActivityBarSegment(duplicate)).toThrow(/already registered/);
  });

  // The following two tests run BEFORE any test that registers additional
  // segments in this file, so the cascade and runState-idle assertions see
  // only the core-registered segments and match the pre-migration output
  // byte-for-byte.
  test("core identity line cascade drops percent → limit → @provider → model qualifier", () => {
    const theme = createNanobossTuiTheme();
    const sep = theme.dim(" • ");
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
      tokenUsage: { used: 32_499, limit: 168_000, percent: 19.3 },
      defaultAgentSelection: { provider: "copilot" as const, model: "claude-opus-4.7/medium" },
      agentLabel: "copilot/claude-opus-4.7/medium",
    };

    const at = (width: number) => stripAnsi(buildActivityBarLine("identity", state, theme, 0, sep, width) ?? "");

    const full = at(120);
    expect(full).toContain("@copilot");
    expect(full).toContain("claude-opus-4.7/medium");
    expect(full).toContain("(19%)");

    const l1 = at(55);
    expect(l1).not.toContain("(19%)");
    expect(l1).toContain("tok 32.5k/168k");
    expect(l1).toContain("@copilot");

    const l2 = at(49);
    expect(l2).not.toContain("168k");
    expect(l2).toContain("tok 32.5k");
    expect(l2).toContain("@copilot");

    const l3 = at(44);
    expect(l3).not.toContain("@copilot");
    expect(l3).toContain("claude-opus-4.7/medium");
    expect(l3).toContain("tok 32.5k");

    const l4 = at(33);
    expect(l4).not.toContain("/medium");
    expect(l4).toContain("claude-opus-4.7");
    expect(l4).toContain("tok 32.5k");
  });

  test("shouldRender filters segments out of the line entirely", () => {
    const theme = createNanobossTuiTheme();
    const sep = theme.dim(" • ");
    const idle = { ...createInitialUiState({ cwd: "/repo" }), sessionId: "session-1" };
    const runStateIdle = buildActivityBarLine("runState", idle, theme, 0, sep);
    expect(runStateIdle).toBeUndefined();

    const busy = { ...idle, inputDisabled: true, inputDisabledReason: "run" as const, runStartedAtMs: 0 };
    const runStateBusy = stripAnsi(buildActivityBarLine("runState", busy, theme, 5_000, sep) ?? "");
    expect(runStateBusy).toContain("● busy");
    expect(runStateBusy.length).toBeGreaterThan("● busy".length);
  });

  test("segments respect line assignment (identity vs runState)", () => {
    const suffix = Math.random().toString(36).slice(2);
    const identityId = `test.line.identity.${suffix}`;
    const runStateId = `test.line.runState.${suffix}`;
    registerActivityBarSegment({
      id: identityId,
      line: "identity",
      order: 999,
      render: () => "__identity_only_marker__",
    });
    registerActivityBarSegment({
      id: runStateId,
      line: "runState",
      order: 999,
      render: () => "__run_state_only_marker__",
    });

    const theme = createNanobossTuiTheme();
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
      simplify2AutoApprove: true,
    };
    const sep = theme.dim(" • ");
    const identityLine = stripAnsi(buildActivityBarLine("identity", state, theme, 0, sep) ?? "");
    const runStateLine = stripAnsi(buildActivityBarLine("runState", state, theme, 0, sep) ?? "");

    expect(identityLine).toContain("__identity_only_marker__");
    expect(identityLine).not.toContain("__run_state_only_marker__");
    expect(runStateLine).toContain("__run_state_only_marker__");
    expect(runStateLine).not.toContain("__identity_only_marker__");
  });

  test("priority-drop cascade drops lowest-priority segment first", () => {
    const suffix = Math.random().toString(36).slice(2);
    const lowId = `test.cascade.low.${suffix}`;
    const highId = `test.cascade.high.${suffix}`;
    registerActivityBarSegment({
      id: lowId,
      line: "runState",
      order: 1000,
      priority: -1000,
      shouldRender: (state) => state.cwd === "/cascade-test",
      render: () => "__low_priority_marker_long__",
    });
    registerActivityBarSegment({
      id: highId,
      line: "runState",
      order: 1001,
      priority: 1000,
      shouldRender: (state) => state.cwd === "/cascade-test",
      render: () => "__high_priority_marker_long__",
    });

    const theme = createNanobossTuiTheme();
    const sep = theme.dim(" • ");
    const state = { ...createInitialUiState({ cwd: "/cascade-test" }), sessionId: "session-1" };

    const wide = stripAnsi(buildActivityBarLine("runState", state, theme, 0, sep, 200) ?? "");
    expect(wide).toContain("__low_priority_marker_long__");
    expect(wide).toContain("__high_priority_marker_long__");

    const narrow = stripAnsi(buildActivityBarLine("runState", state, theme, 0, sep, 30) ?? "");
    expect(narrow).not.toContain("__low_priority_marker_long__");
    expect(narrow).toContain("__high_priority_marker_long__");
  });
});
