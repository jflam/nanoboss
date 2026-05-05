import {
  createHttpSession,
  ensureMatchingHttpServer,
  resumeHttpSession,
} from "@nanoboss/adapters-http";
import type { DownstreamAgentSelection } from "@nanoboss/contracts";

import { getBuildFreshnessNotice } from "../run/build-freshness.ts";
import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";
import type { SessionResponse } from "./controller-types.ts";
import type { UiAction } from "../reducer/reducer-actions.ts";
import type { UiState } from "../state/state.ts";

export interface ControllerSessionDeps {
  ensureMatchingHttpServer?: typeof ensureMatchingHttpServer;
  createHttpSession?: typeof createHttpSession;
  resumeHttpSession?: typeof resumeHttpSession;
}

export async function connectControllerSession(params: {
  deps: ControllerSessionDeps;
  serverUrl: string;
  cwd: string;
  sessionId?: string;
  simplify2AutoApprove?: boolean;
  onStatus: (text: string) => void;
}): Promise<{
  session: SessionResponse;
  buildFreshnessNotice?: string;
}> {
  const buildFreshnessNotice = getBuildFreshnessNotice(params.cwd);

  await (params.deps.ensureMatchingHttpServer ?? ensureMatchingHttpServer)(params.serverUrl, {
    cwd: params.cwd,
    onStatus: params.onStatus,
  });

  const session = params.sessionId
    ? await (params.deps.resumeHttpSession ?? resumeHttpSession)(
      params.serverUrl,
      params.sessionId,
      params.cwd,
      params.simplify2AutoApprove,
    )
    : await createControllerSession({
      deps: params.deps,
      serverUrl: params.serverUrl,
      cwd: params.cwd,
      simplify2AutoApprove: params.simplify2AutoApprove,
    });

  return {
    session,
    buildFreshnessNotice,
  };
}

async function createControllerSession(params: {
  deps: ControllerSessionDeps;
  serverUrl: string;
  cwd: string;
  simplify2AutoApprove?: boolean;
  defaultAgentSelection?: DownstreamAgentSelection;
}): Promise<SessionResponse> {
  return await (params.deps.createHttpSession ?? createHttpSession)(
    params.serverUrl,
    params.cwd,
    params.simplify2AutoApprove,
    params.defaultAgentSelection,
  );
}

export async function createAndApplyControllerSession(params: {
  deps: ControllerSessionDeps;
  serverUrl: string;
  cwd: string;
  state: UiState;
  dispatch: (action: UiAction) => void;
  applySession: (session: SessionResponse) => Promise<void>;
  showLocalCard: (opts: ControllerLocalCardOptions) => void;
}): Promise<void> {
  params.dispatch({ type: "local_status", text: "[session] creating new session…" });

  try {
    const session = await createControllerSession({
      deps: params.deps,
      serverUrl: params.serverUrl,
      cwd: params.cwd,
      simplify2AutoApprove: params.state.simplify2AutoApprove,
      defaultAgentSelection: params.state.defaultAgentSelection,
    });
    await params.applySession(session);
    // applySession dispatches session_ready which resets procedurePanels,
    // so the confirmation card is emitted *after* the reset to survive.
    params.showLocalCard({
      key: "local:session",
      title: "Session",
      markdown: `Started new session \`${session.sessionId}\`.`,
      severity: "info",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.showLocalCard({
      key: "local:session",
      title: "Session",
      markdown: `Failed to create new session: ${message}`,
      severity: "error",
    });
  }
}
