import {
  setSessionAutoApprove,
  type FrontendCommand,
  type FrontendEventEnvelope,
  type SessionStreamHandle,
} from "@nanoboss/adapters-http";
import type { DownstreamAgentSelection } from "@nanoboss/contracts";
import type { TuiExtensionStatus } from "@nanoboss/tui-extension-catalog";

import type { UiState } from "./state.ts";
import type { ControllerModelSelectionDeps } from "./controller-model-selection.ts";
import type { ControllerPromptFlowDeps } from "./controller-prompt-flow.ts";
import type { ControllerSessionDeps } from "./controller-session.ts";
import type { ControllerStopDeps } from "./controller-stop.ts";

export interface SessionResponse {
  sessionId: string;
  cwd: string;
  commands: FrontendCommand[];
  buildLabel: string;
  agentLabel: string;
  autoApprove: boolean;
  defaultAgentSelection?: DownstreamAgentSelection;
}

export interface NanobossTuiControllerParams {
  cwd?: string;
  serverUrl: string;
  showToolCalls: boolean;
  sessionId?: string;
  simplify2AutoApprove?: boolean;
}

export interface NanobossTuiControllerDeps
  extends ControllerModelSelectionDeps, ControllerSessionDeps, ControllerStopDeps, ControllerPromptFlowDeps {
  setSessionAutoApprove?: typeof setSessionAutoApprove;
  startSessionEventStream?: (params: {
    baseUrl: string;
    sessionId: string;
    onEvent: (event: FrontendEventEnvelope) => void;
    onError?: (error: unknown) => void;
  }) => SessionStreamHandle;
  promptForModelSelection?: (
    currentSelection?: DownstreamAgentSelection,
  ) => Promise<DownstreamAgentSelection | undefined>;
  /**
   * Snapshot of loaded TUI extensions, used to serve the `/extensions`
   * slash command. Supplied at boot by runTuiCli from the
   * `TuiExtensionRegistry` returned by `bootExtensions`.
   */
  listExtensionEntries?: () => readonly TuiExtensionStatus[];
  onStateChange?: (state: UiState) => void;
  onExit?: () => void;
  onClearInput?: () => void;
  onAddHistory?: (text: string) => void;
}
