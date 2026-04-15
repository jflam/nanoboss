import { createAgentSession } from "@nanoboss/agent-acp";
import { formatAgentBanner } from "@nanoboss/procedure-sdk";
import {
  SessionStore,
  readStoredSessionMetadata,
  writeStoredSessionMetadata,
} from "@nanoboss/store";

import { getBuildLabel } from "../../../src/core/build-info.ts";
import type { SessionMetadata } from "../../../src/core/contracts.ts";
import { toDownstreamAgentSelection } from "../../../src/core/config.ts";
import type {
  AgentSession,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  PendingContinuation,
} from "../../../src/core/types.ts";

import { shouldPrewarmDefaultAgentSession } from "./default-agent-policy.ts";
import { SessionEventLog, type RuntimeCommand } from "./runtime-events.ts";
import type { ActiveRunState } from "./active-run.ts";

export interface SessionState {
  cwd: string;
  store: SessionStore;
  events: SessionEventLog;
  autoApprove: boolean;
  defaultAgentConfig: DownstreamAgentConfig;
  defaultAgentSession: AgentSession;
  syncedProcedureMemoryRunIds: Set<string>;
  recentRecoverySyncAtMs?: number;
  activeRun?: ActiveRunState;
  commands: RuntimeCommand[];
  pendingContinuation?: PendingContinuation;
}

export interface RuntimeSessionDescriptor {
  sessionId: string;
  cwd: string;
  commands: RuntimeCommand[];
  buildLabel: string;
  agentLabel: string;
  autoApprove: boolean;
  defaultAgentSelection?: DownstreamAgentSelection;
}

export function createSessionState(params: {
  sessionId: string;
  cwd: string;
  commands: RuntimeCommand[];
  resolveDefaultAgentConfig: (
    cwd: string,
    selection?: DownstreamAgentSelection,
  ) => DownstreamAgentConfig;
  autoApprove?: boolean;
  defaultAgentSelection?: DownstreamAgentSelection;
  defaultAgentSessionId?: string;
  pendingContinuation?: PendingContinuation;
}): SessionState {
  const defaultAgentConfig = params.resolveDefaultAgentConfig(
    params.cwd,
    params.defaultAgentSelection,
  );
  const store = new SessionStore({
    sessionId: params.sessionId,
    cwd: params.cwd,
  });
  const defaultAgentSession = createAgentSession({
    config: defaultAgentConfig,
    persistedSessionId: params.defaultAgentSessionId,
  });
  if (shouldPrewarmDefaultAgentSession()) {
    void defaultAgentSession.warm?.();
  }

  return {
    cwd: params.cwd,
    store,
    events: new SessionEventLog(),
    autoApprove: params.autoApprove === true,
    defaultAgentConfig,
    defaultAgentSession,
    syncedProcedureMemoryRunIds: new Set(),
    commands: params.commands,
    pendingContinuation: params.pendingContinuation,
  };
}

export function buildSessionDescriptor(
  sessionId: string,
  state: SessionState,
): RuntimeSessionDescriptor {
  return {
    sessionId,
    cwd: state.cwd,
    commands: state.commands,
    buildLabel: getBuildLabel(),
    agentLabel: formatAgentBanner(state.defaultAgentConfig),
    autoApprove: state.autoApprove,
    defaultAgentSelection: toDownstreamAgentSelection(state.defaultAgentConfig),
  };
}

export function persistSessionState(
  session: SessionState,
  options: { prompt?: string; preserveDefaultAcpSessionId?: boolean } = {},
): SessionMetadata {
  const existing = readStoredSessionMetadata(session.store.sessionId, session.store.rootDir);
  const defaultAgentSessionId = session.defaultAgentSession.sessionId
    ?? (options.preserveDefaultAcpSessionId === false ? undefined : existing?.defaultAgentSessionId);

  return writeStoredSessionMetadata({
    session: { sessionId: session.store.sessionId },
    cwd: session.cwd,
    rootDir: session.store.rootDir,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    initialPrompt: existing?.initialPrompt ?? options.prompt,
    lastPrompt: options.prompt ?? existing?.lastPrompt,
    autoApprove: session.autoApprove,
    defaultAgentSelection: toDownstreamAgentSelection(session.defaultAgentConfig),
    defaultAgentSessionId,
    pendingContinuation: session.pendingContinuation,
  });
}
