import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";
import {
  connectControllerSession,
  type ControllerSessionDeps,
} from "./controller-session.ts";
import type { SessionResponse } from "./controller-types.ts";

export async function runControllerSession(params: {
  deps: ControllerSessionDeps;
  serverUrl: string;
  cwd: string;
  sessionId?: string;
  simplify2AutoApprove?: boolean;
  exited: Promise<void>;
  getCurrentSessionId: () => string | undefined;
  onStatus: (text: string) => void;
  applySession: (session: SessionResponse) => Promise<void>;
  showLocalCard: (opts: ControllerLocalCardOptions) => void;
  stop: () => Promise<void>;
}): Promise<string | undefined> {
  try {
    const { session, buildFreshnessNotice } = await connectControllerSession({
      deps: params.deps,
      serverUrl: params.serverUrl,
      cwd: params.cwd,
      sessionId: params.sessionId,
      simplify2AutoApprove: params.simplify2AutoApprove,
      onStatus: params.onStatus,
    });
    await params.applySession(session);
    // Cards are emitted *after* applySession because session_ready
    // resets procedurePanels as part of initial-state derivation.
    if (buildFreshnessNotice) {
      params.showLocalCard({
        key: "local:build-freshness",
        title: "Build",
        markdown: buildFreshnessNotice,
        severity: "warn",
      });
    }
    if (params.sessionId) {
      params.showLocalCard({
        key: "local:session",
        title: "Session",
        markdown: `Resumed session \`${session.sessionId}\`.`,
        severity: "info",
      });
    }

    await params.exited;
    return params.getCurrentSessionId() || session.sessionId;
  } finally {
    await params.stop();
  }
}
