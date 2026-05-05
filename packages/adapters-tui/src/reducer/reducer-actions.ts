import type {
  FrontendCommand,
  RenderedFrontendEventEnvelope,
} from "@nanoboss/adapters-http";
import type { DownstreamAgentSelection } from "@nanoboss/contracts";

import type { UiPendingPrompt } from "../state/state.ts";
import type { ToolCardThemeMode } from "../theme/theme.ts";

export type UiAction =
  | {
      type: "session_ready";
      sessionId: string;
      cwd: string;
      buildLabel: string;
      agentLabel: string;
      autoApprove: boolean;
      commands: FrontendCommand[];
      defaultAgentSelection?: DownstreamAgentSelection;
    }
  | {
      type: "local_user_submitted";
      text: string;
    }
  | {
      type: "local_send_failed";
      error: string;
    }
  | {
      type: "local_status";
      text?: string;
    }
  | {
      type: "local_busy_started";
      text: string;
    }
  | {
      type: "local_busy_finished";
    }
  | {
      type: "local_stop_requested";
      runId?: string;
    }
  | {
      type: "local_stop_request_failed";
      runId?: string;
      text: string;
    }
  | {
      type: "local_pending_prompt_added";
      prompt: UiPendingPrompt;
    }
  | {
      type: "local_pending_prompt_removed";
      promptId: string;
    }
  | {
      type: "local_pending_prompts_cleared";
      text: string;
    }
  | {
      type: "local_agent_selection";
      agentLabel: string;
      selection: DownstreamAgentSelection;
    }
  | {
      type: "local_tool_card_theme_mode";
      mode: ToolCardThemeMode;
    }
  | {
      type: "local_simplify2_auto_approve";
      enabled: boolean;
    }
  | {
      type: "session_auto_approve";
      enabled: boolean;
    }
  | {
      type: "toggle_tool_output";
    }
  | {
      type: "toggle_tool_cards_hidden";
    }
  | {
      /**
       * Insert (or in-place replace) a procedure-panel-shaped transcript
       * card from a local source such as a slash command. Unlike a real
       * `procedure_panel` frontend event this action:
       *
       * - Does NOT bind to `activeAssistantTurnId` (no turnId).
       * - Does NOT call `appendProcedurePanelBlockToActiveTurn`, so a
       *   mid-run `/extensions` cannot split the streaming assistant
       *   turn into multiple turns.
       * - Does NOT call `markAssistantTextBoundary`.
       *
       * In-place replacement keys by (rendererId, key) with runId always
       * undefined so repeated invocations of the same local command
       * collapse onto a single transcript card.
       */
      type: "local_procedure_panel";
      panelId: string;
      rendererId: string;
      payload: unknown;
      severity: "info" | "warn" | "error";
      dismissible: boolean;
      key?: string;
      procedure?: string;
    }
  | {
      type: "frontend_event";
      event: RenderedFrontendEventEnvelope;
    };

export type UiLocalAction = Exclude<UiAction, { type: "frontend_event" }>;
