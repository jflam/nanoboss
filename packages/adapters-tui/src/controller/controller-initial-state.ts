import { getBuildLabel } from "@nanoboss/app-support";

import { createInitialUiState, type UiState } from "../state/state.ts";

export function createControllerInitialState(params: {
  cwd: string;
  showToolCalls: boolean;
  simplify2AutoApprove?: boolean;
}): UiState {
  return createInitialUiState({
    cwd: params.cwd,
    buildLabel: getBuildLabel(),
    agentLabel: "connecting",
    showToolCalls: params.showToolCalls,
    simplify2AutoApprove: params.simplify2AutoApprove,
  });
}
