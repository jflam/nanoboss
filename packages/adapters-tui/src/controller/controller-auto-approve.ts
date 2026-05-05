import { setSessionAutoApprove } from "@nanoboss/adapters-http";

import type { UiAction } from "../reducer/reducer-actions.ts";
import type { UiState } from "../state/state.ts";

export interface ControllerAutoApproveDeps {
  setSessionAutoApprove?: typeof setSessionAutoApprove;
}

type Dispatch = (action: UiAction) => void;

export async function toggleSessionAutoApprove(params: {
  deps: ControllerAutoApproveDeps;
  serverUrl: string;
  state: UiState;
  dispatch: Dispatch;
}): Promise<void> {
  const sessionId = params.state.sessionId;
  if (!sessionId) {
    return;
  }

  const enabled = !params.state.simplify2AutoApprove;
  try {
    const session = await (params.deps.setSessionAutoApprove ?? setSessionAutoApprove)(
      params.serverUrl,
      sessionId,
      enabled,
    );
    params.dispatch({ type: "session_auto_approve", enabled: session.autoApprove });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.dispatch({ type: "local_status", text: `[session] failed to update auto-approve: ${message}` });
  }
}
