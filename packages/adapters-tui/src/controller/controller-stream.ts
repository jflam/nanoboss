import {
  isRenderedFrontendEvent,
  startSessionEventStream,
  type FrontendEventEnvelope,
  type SessionStreamHandle,
} from "@nanoboss/adapters-http";

import type { UiAction } from "../reducer/reducer-actions.ts";
import type { SessionResponse } from "./controller-types.ts";

export interface ControllerStreamDeps {
  startSessionEventStream?: (params: {
    baseUrl: string;
    sessionId: string;
    onEvent: (event: FrontendEventEnvelope) => void;
    onError?: (error: unknown) => void;
  }) => SessionStreamHandle;
}

type Dispatch = (action: UiAction) => void;

export async function applyControllerSessionStream(params: {
  deps: ControllerStreamDeps;
  serverUrl: string;
  stream?: SessionStreamHandle;
  session: SessionResponse;
  dispatch: Dispatch;
  onEvent: (event: FrontendEventEnvelope) => void;
}): Promise<SessionStreamHandle> {
  if (params.stream) {
    params.stream.close();
    await params.stream.closed;
  }

  params.dispatch({
    type: "session_ready",
    sessionId: params.session.sessionId,
    cwd: params.session.cwd,
    buildLabel: params.session.buildLabel,
    agentLabel: params.session.agentLabel,
    autoApprove: params.session.autoApprove,
    commands: params.session.commands,
    defaultAgentSelection: params.session.defaultAgentSelection,
  });

  return (params.deps.startSessionEventStream ?? startSessionEventStream)({
    baseUrl: params.serverUrl,
    sessionId: params.session.sessionId,
    onEvent: (event) => {
      if (isRenderedFrontendEvent(event)) {
        params.dispatch({ type: "frontend_event", event });
      }
      params.onEvent(event);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      params.dispatch({ type: "local_status", text: `[stream] ${message}` });
    },
  });
}

export async function closeControllerStream(
  stream: SessionStreamHandle | undefined,
): Promise<undefined> {
  if (!stream) {
    return undefined;
  }

  stream.close();
  await stream.closed;
  return undefined;
}
