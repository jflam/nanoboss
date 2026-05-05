import type {
  ControllerLike,
  EditorLike,
} from "./app-types.ts";

export class AppSigintExit {
  private lastCtrlCAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly deps: {
      controller: ControllerLike;
      editor: EditorLike;
      now: () => number;
      exitWindowMs: number;
    },
  ) {}

  request(): boolean {
    const now = this.deps.now();
    if (now - this.lastCtrlCAt < this.deps.exitWindowMs) {
      this.deps.controller.requestExit();
      return true;
    }

    this.lastCtrlCAt = now;
    this.deps.editor.setText("");
    return false;
  }
}
