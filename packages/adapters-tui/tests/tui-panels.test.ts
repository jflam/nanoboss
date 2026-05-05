import { beforeAll, describe, expect, test } from "bun:test";

import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";
import {
  bootExtensions,
  createInitialUiState,
  createNanobossTuiTheme,
  NanobossAppView,
  reduceUiState,
} from "@nanoboss/adapters-tui";
import {
  getPanelRenderer,
  registerPanelRenderer,
} from "../src/core/panel-renderers.ts";

// The `nb/card@1` panel renderer is contributed by the built-in
// `nanoboss-core-ui` TUI extension, which is only registered at
// `bootExtensions()` time from adapters-tui's builtin extension list.
// Per-package `bun test` runs pick up
// `packages/adapters-tui/bunfig.toml`'s `[test].preload`, which activates the
// builtins via `tests/preload-boot-extensions.ts`. But Bun only reads the
// bunfig in the CWD where `bun test` is invoked, so runs from the repo root
// skip that preload and `getPanelRenderer("nb/card@1")` returns undefined.
// Make the dependency explicit here so tests pass regardless of CWD. The
// guard keeps the per-package run idempotent (no duplicate-activation
// shadow-warning noise when preload already registered the renderer).
beforeAll(async () => {
  if (getPanelRenderer("nb/card@1")) return;
  await bootExtensions("/tmp/nanoboss-adapters-tui-tests-panels", {
    extensionRoots: [],
    skipDisk: true,
    log: () => {},
  });
});

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(27);
  let result = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char === esc && text.charAt(i + 1) === "[") {
      let c = i + 2;
      while (c < text.length) {
        const code = text.charCodeAt(c);
        if ((code < 48 || code > 57) && code !== 59) break;
        c += 1;
      }
      if (text.charAt(c) === "m") {
        i = c;
        continue;
      }
    }
    result += char;
  }
  return result;
}

function eventEnvelope<EventType extends RenderedFrontendEventEnvelope["type"]>(
  type: EventType,
  data: Extract<RenderedFrontendEventEnvelope, { type: EventType }>["data"],
): RenderedFrontendEventEnvelope {
  return {
    sessionId: "session-1",
    seq: 1,
    type,
    data,
  } as RenderedFrontendEventEnvelope;
}

function newRunState(): ReturnType<typeof createInitialUiState> {
  let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });
  state = reduceUiState(state, {
    type: "frontend_event",
    event: eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "demo",
      prompt: "hi",
      startedAt: new Date(0).toISOString(),
    }),
  });
  return state;
}

describe("tui panels", () => {
  test("ui_panel { rendererId: 'nb/card@1' } renders identically to procedure_card transcript card", () => {
    let cardState = newRunState();
    cardState = reduceUiState(cardState, {
      type: "frontend_event",
      event: eventEnvelope("procedure_card", {
        runId: "run-1",
        card: {
          type: "card",
          procedure: "demo",
          kind: "report",
          title: "Checkpoint",
          markdown: "- a\n- b",
        },
      }),
    });

    let panelState = newRunState();
    panelState = reduceUiState(panelState, {
      type: "frontend_event",
      event: eventEnvelope("ui_panel", {
        runId: "run-1",
        procedure: "demo",
        rendererId: "nb/card@1",
        slot: "transcript",
        payload: {
          kind: "report",
          title: "Checkpoint",
          markdown: "- a\n- b",
        },
        lifetime: "run",
      }),
    });

    const cardTurn = cardState.turns.at(-1);
    const panelTurn = panelState.turns.at(-1);

    // The two paths must produce identical final turn shapes so the
    // view layer renders them byte-for-byte the same.
    expect(panelTurn).toMatchObject({
      role: cardTurn?.role,
      displayStyle: cardTurn?.displayStyle,
      cardTone: cardTurn?.cardTone,
      markdown: cardTurn?.markdown,
      status: cardTurn?.status,
      runId: cardTurn?.runId,
      meta: { procedure: cardTurn?.meta?.procedure },
    });
  });

  test("ui.panel via nb/card@1 renders identically in the TUI view", () => {
    let cardState = newRunState();
    cardState = reduceUiState(cardState, {
      type: "frontend_event",
      event: eventEnvelope("procedure_card", {
        runId: "run-1",
        card: {
          type: "card",
          procedure: "demo",
          kind: "summary",
          title: "Final summary",
          markdown: "all done",
        },
      }),
    });

    let panelState = newRunState();
    panelState = reduceUiState(panelState, {
      type: "frontend_event",
      event: eventEnvelope("ui_panel", {
        runId: "run-1",
        procedure: "demo",
        rendererId: "nb/card@1",
        slot: "transcript",
        payload: {
          kind: "summary",
          title: "Final summary",
          markdown: "all done",
        },
        lifetime: "run",
      }),
    });

    const theme = createNanobossTuiTheme();
    const cardView = new NanobossAppView(
      { render: () => [""], invalidate() {} } as never,
      theme,
      cardState,
    );
    const panelView = new NanobossAppView(
      { render: () => [""], invalidate() {} } as never,
      theme,
      panelState,
    );

    const cardPlain = cardView.render(120).map(stripAnsi).join("\n");
    const panelPlain = panelView.render(120).map(stripAnsi).join("\n");

    expect(panelPlain).toBe(cardPlain);
    expect(panelPlain).toContain("Final summary");
  });

  test("invalid ui_panel payload surfaces as a diagnostic status line and does not crash", () => {
    let state = newRunState();
    const before = state.panels.length;

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("ui_panel", {
        runId: "run-1",
        procedure: "demo",
        rendererId: "nb/card@1",
        slot: "transcript",
        // missing required `markdown` field — typia validation should reject.
        payload: { kind: "summary", title: "Broken" },
        lifetime: "run",
      }),
    });

    expect(state.panels.length).toBe(before);
    // No turn was created for the invalid card payload.
    expect(state.turns.every((turn) => !turn.markdown.includes("Broken"))).toBe(true);
    expect(state.statusLine).toContain("[panel] invalid payload");
  });

  test("unknown renderer id surfaces as a diagnostic status line and does not crash", () => {
    let state = newRunState();

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("ui_panel", {
        runId: "run-1",
        procedure: "demo",
        rendererId: "acme/no-such@1",
        slot: "status",
        payload: { anything: 1 },
        lifetime: "run",
      }),
    });

    expect(state.panels).toHaveLength(0);
    expect(state.statusLine).toContain("[panel] unknown renderer");
  });

  test("panel lifetime scopes are evicted at the right boundaries (turn/run/session)", () => {
    // Register a synthetic renderer for non-transcript slots so we can
    // exercise the generic panel store (nb/card@1 materializes into
    // turns instead).
    if (!getPanelRenderer("test/free@1")) {
      registerPanelRenderer({
        rendererId: "test/free@1",
        schema: {
          schema: {},
          validate: (_input: unknown): _input is unknown => true,
        },
        render: () => ({ render: () => [""], invalidate() {} }),
      });
    }

    let state = createInitialUiState({ cwd: "/repo" });
    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "first",
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "demo",
        prompt: "first",
        startedAt: new Date(0).toISOString(),
      }),
    });

    // Add one panel per lifetime scope in the status slot.
    const addPanel = (runId: string, key: string, lifetime: "turn" | "run" | "session") => {
      state = reduceUiState(state, {
        type: "frontend_event",
        event: eventEnvelope("ui_panel", {
          runId,
          procedure: "demo",
          rendererId: "test/free@1",
          slot: "status",
          key,
          payload: { key },
          lifetime,
        }),
      });
    };
    addPanel("run-1", "t", "turn");
    addPanel("run-1", "r", "run");
    addPanel("run-1", "s", "session");
    expect(state.panels.map((p) => p.key).sort()).toEqual(["r", "s", "t"]);

    // Completing the run evicts run- and turn-scoped panels; session
    // survives.
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "demo",
        completedAt: new Date(1).toISOString(),
        run: { sessionId: "session-1", runId: "run-1" },
      }),
    });
    expect(state.panels.map((p) => p.key)).toEqual(["s"]);

    // Re-add a turn-scoped panel in the next run, then start a new
    // user turn: turn-scoped panels are evicted, session stays.
    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "second",
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-2",
        procedure: "demo",
        prompt: "second",
        startedAt: new Date(2).toISOString(),
      }),
    });
    addPanel("run-2", "t2", "turn");
    expect(state.panels.map((p) => p.key).sort()).toEqual(["s", "t2"]);

    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "third",
    });
    expect(state.panels.map((p) => p.key)).toEqual(["s"]);

    // session_ready creates a fresh state, so session-scoped panels
    // are cleared by the new session boundary.
    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-2",
      cwd: "/repo",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      autoApprove: false,
      commands: [],
    });
    expect(state.panels).toHaveLength(0);
  });
});
