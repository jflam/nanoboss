import type {
  DownstreamAgentConfig,
  DownstreamAgentSelection,
} from "@nanoboss/procedure-sdk";
import type {
  RuntimeBindings,
} from "@nanoboss/procedure-engine";
import type { RunTimingTrace } from "@nanoboss/app-support";

import { prepareDefaultPrompt } from "./default-agent-policy.ts";
import { persistSessionState, type SessionState } from "./session-runtime.ts";

export function createProcedureRuntimeBindings(params: {
  session: SessionState;
  runId: string;
  timingTrace?: RunTimingTrace;
  resolveDefaultAgentConfig: (
    cwd: string,
    selection?: DownstreamAgentSelection,
  ) => DownstreamAgentConfig;
}): RuntimeBindings {
  return {
    agentSession: params.session.defaultAgentSession,
    getDefaultAgentConfig: () => params.session.defaultAgentConfig,
    setDefaultAgentSelection: (selection) => {
      const nextConfig = params.resolveDefaultAgentConfig(params.session.cwd, selection);
      params.session.defaultAgentConfig = nextConfig;
      params.session.defaultAgentSession.updateConfig(nextConfig);
      return nextConfig;
    },
    prepareDefaultPrompt: (prompt) => prepareDefaultPrompt(
      params.session,
      prompt,
      params.runId,
      params.timingTrace,
    ),
  };
}

export function applyDefaultAgentSelection(params: {
  session: SessionState;
  selection: DownstreamAgentSelection | undefined;
  resolveDefaultAgentConfig: (
    cwd: string,
    selection?: DownstreamAgentSelection,
  ) => DownstreamAgentConfig;
  currentSelection: DownstreamAgentSelection | undefined;
}): void {
  if (!params.selection) {
    return;
  }

  if (JSON.stringify(params.currentSelection) === JSON.stringify(params.selection)) {
    return;
  }

  const nextConfig = params.resolveDefaultAgentConfig(params.session.cwd, params.selection);
  params.session.defaultAgentConfig = nextConfig;
  params.session.defaultAgentSession.updateConfig(nextConfig);
  persistSessionState(params.session, { preserveDefaultAcpSessionId: false });
}
