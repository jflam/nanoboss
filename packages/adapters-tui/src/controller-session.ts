import {
  createHttpSession,
  ensureMatchingHttpServer,
  resumeHttpSession,
} from "@nanoboss/adapters-http";
import type { DownstreamAgentSelection } from "@nanoboss/contracts";

import { getBuildFreshnessNotice } from "./build-freshness.ts";
import type { SessionResponse } from "./controller.ts";

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

export async function createControllerSession(params: {
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
