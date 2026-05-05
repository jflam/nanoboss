import typia from "typia";

import { jsonType } from "@nanoboss/procedure-sdk";

import {
  Simplify2ContinuationOverlay,
  type Simplify2CheckpointAction,
} from "../overlays/simplify2-continuation-overlay.ts";
import {
  Simplify2FocusPickerOverlay,
  type Simplify2FocusPickerEntry,
} from "../overlays/simplify2-focus-picker-overlay.ts";
import type { Component, TUI } from "../shared/pi-tui.ts";
import { registerFormRenderer } from "./form-renderers.ts";

// The simplify2 overlays only use TUI.requestRender inside handleInput
// to force an immediate redraw after consuming a key. The form-registry
// mount path always schedules a redraw via the app's own tui instance
// immediately after submit/cancel/editor-seed, so a no-op stub is safe
// here and lets the renderers stay agnostic of the live TUI.
const NO_OP_TUI = {
  requestRender() {},
} as unknown as TUI;

/**
 * Payload accepted by the nb/simplify2-checkpoint@1 form. Declared
 * locally now that the closed ContinuationUi union has been removed
 * from contracts; the shape continues to match what simplify2 emits
 * at its checkpoint pause site.
 */
interface Simplify2CheckpointV1Payload {
  kind: "simplify2_checkpoint";
  title: string;
  actions: Simplify2CheckpointAction[];
}

const Simplify2CheckpointV1PayloadType = jsonType<Simplify2CheckpointV1Payload>(
  typia.json.schema<Simplify2CheckpointV1Payload>(),
  typia.createValidate<Simplify2CheckpointV1Payload>(),
);

const SIMPLIFY2_CHECKPOINT_FORM_ID = "nb/simplify2-checkpoint@1";
const SIMPLIFY2_FOCUS_PICKER_FORM_ID = "nb/simplify2-focus-picker@1";

registerFormRenderer<Simplify2CheckpointV1Payload>({
  formId: SIMPLIFY2_CHECKPOINT_FORM_ID,
  schema: Simplify2CheckpointV1PayloadType,
  render({ payload, theme, submit, cancel }): Component {
    return new Simplify2ContinuationOverlay(
      NO_OP_TUI,
      theme,
      payload.title,
      payload.actions,
      (action) => {
        if (!action) {
          cancel();
          return;
        }
        if (action.reply) {
          submit(action.reply);
          return;
        }
        // "other" (and any future non-reply action): close the overlay
        // without driving the continuation forward. The engine-
        // authoritative cancel path terminates the paused run so the
        // user can type a free-form reply in the default composer.
        cancel();
      },
    );
  },
});

interface Simplify2FocusPickerV1Action {
  id: "continue" | "archive" | "new" | "cancel";
  label: string;
}

interface Simplify2FocusPickerV1Payload {
  kind: "simplify2_focus_picker";
  title: string;
  entries: Simplify2FocusPickerEntry[];
  actions: Simplify2FocusPickerV1Action[];
}

const Simplify2FocusPickerV1PayloadType = jsonType<Simplify2FocusPickerV1Payload>(
  typia.json.schema<Simplify2FocusPickerV1Payload>(),
  typia.createValidate<Simplify2FocusPickerV1Payload>(),
);

registerFormRenderer<Simplify2FocusPickerV1Payload>({
  formId: SIMPLIFY2_FOCUS_PICKER_FORM_ID,
  schema: Simplify2FocusPickerV1PayloadType,
  render({ payload, theme, submit, cancel, editor }): Component {
    return new Simplify2FocusPickerOverlay(
      NO_OP_TUI,
      theme,
      payload.title,
      payload.entries,
      (action) => {
        if (action.kind === "cancel") {
          cancel();
          return;
        }
        if (action.kind === "new") {
          editor.setText("new ");
          cancel();
          return;
        }
        const command = action.kind === "archive"
          ? `archive ${action.focusId}`
          : `continue ${action.focusId}`;
        submit(command);
      },
    );
  },
});
