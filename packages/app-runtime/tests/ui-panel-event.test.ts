import { test, expect } from "bun:test";

import { mapProcedureUiEventToRuntimeEvent } from "@nanoboss/app-runtime";
import type { ProcedureUiEvent } from "@nanoboss/procedure-engine";

test("mapProcedureUiEventToRuntimeEvent translates a ui.card-equivalent panel event into a ui_panel runtime event", () => {
  // This mirrors what UiApiImpl.card emits today: a ui_panel procedure
  // event with the nb/card@1 renderer and the (kind,title,markdown) tuple
  // as its payload.
  const event: ProcedureUiEvent = {
    type: "ui_panel",
    procedure: "research",
    rendererId: "nb/card@1",
    slot: "transcript",
    payload: {
      kind: "report",
      title: "Research checkpoint",
      markdown: "- source A\n- source B",
    },
    lifetime: "run",
  };

  const runtimeEvent = mapProcedureUiEventToRuntimeEvent("run-1", event);

  expect(runtimeEvent).toEqual({
    type: "ui_panel",
    runId: "run-1",
    procedure: "research",
    rendererId: "nb/card@1",
    slot: "transcript",
    payload: {
      kind: "report",
      title: "Research checkpoint",
      markdown: "- source A\n- source B",
    },
    lifetime: "run",
  });
});

test("mapProcedureUiEventToRuntimeEvent preserves the key when present", () => {
  const event: ProcedureUiEvent = {
    type: "ui_panel",
    procedure: "demo",
    rendererId: "acme/files@1",
    slot: "status",
    key: "files",
    payload: { files: ["a.txt"] },
    lifetime: "session",
  };

  const runtimeEvent = mapProcedureUiEventToRuntimeEvent("run-2", event);

  expect(runtimeEvent).toMatchObject({
    type: "ui_panel",
    runId: "run-2",
    procedure: "demo",
    rendererId: "acme/files@1",
    slot: "status",
    key: "files",
    lifetime: "session",
  });
});
