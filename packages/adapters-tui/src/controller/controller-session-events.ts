import type { SessionStreamHandle } from "@nanoboss/adapters-http";
import type { PromptInput } from "@nanoboss/contracts";

import type { UiAction } from "../reducer/reducer-actions.ts";
import type { UiState } from "../state/state.ts";
import {
  maybeFlushPendingPrompt as maybeFlushPendingPromptInternal,
} from "./controller-prompt-flow.ts";
import {
  maybeSendLatchedStopRequest as maybeSendLatchedStopRequestInternal,
} from "./controller-stop.ts";
import { applyControllerSessionStream } from "./controller-stream.ts";
import type {
  NanobossTuiControllerDeps,
  SessionResponse,
} from "./controller-types.ts";

export async function applyControllerSessionEventStream(params: {
  deps: NanobossTuiControllerDeps;
  serverUrl: string;
  stream?: SessionStreamHandle;
  session: SessionResponse;
  getState: () => UiState;
  dispatch: (action: UiAction) => void;
  sendStopRequest: (runId: string) => Promise<void>;
  getFlushingPendingPrompt: () => boolean;
  setFlushingPendingPrompt: (flushing: boolean) => void;
  forwardPrompt: (prompt: PromptInput) => Promise<boolean>;
}): Promise<SessionStreamHandle | undefined> {
  return await applyControllerSessionStream({
    deps: params.deps,
    serverUrl: params.serverUrl,
    stream: params.stream,
    session: params.session,
    dispatch: params.dispatch,
    onEvent: (event) => {
      maybeSendLatchedStopRequestInternal({
        event,
        state: params.getState(),
        sendStopRequest: (runId) => {
          void params.sendStopRequest(runId);
        },
      });
      void maybeFlushPendingPromptInternal({
        event,
        getState: params.getState,
        flushingPendingPrompt: params.getFlushingPendingPrompt(),
        setFlushingPendingPrompt: params.setFlushingPendingPrompt,
        forwardPrompt: params.forwardPrompt,
        dispatch: params.dispatch,
      });
    },
  });
}
