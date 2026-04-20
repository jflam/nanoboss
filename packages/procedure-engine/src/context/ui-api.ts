import type * as acp from "@agentclientprotocol/sdk";

import type {
  UiApi,
  UiCardParams,
  UiPanelParams,
  UiProcedurePanelParams,
  UiStatusParams,
} from "@nanoboss/procedure-sdk";
import type { SessionStore } from "@nanoboss/store";

import type { RunLogger } from "../logger.ts";
import { formatProcedureStatusText } from "../ui-events.ts";
import type { SessionUpdateEmitter } from "./shared.ts";

const NOTICE_LABELS = {
  info: "Info",
  warning: "Warning",
  error: "Error",
} as const;

type ActiveRun = ReturnType<SessionStore["startRun"]>;
type NoticeTone = keyof typeof NOTICE_LABELS;

export class UiApiImpl implements UiApi {
  constructor(
    private readonly store: SessionStore,
    private readonly run: ActiveRun,
    private readonly logger: RunLogger,
    private readonly spanId: string,
    private readonly procedureName: string,
    private readonly emitter: SessionUpdateEmitter,
    private readonly assertNotCancelled?: () => void,
  ) {}

  text(text: string): void {
    this.assertNotCancelled?.();
    this.store.appendStream(this.run, text);
    this.log(text);
    this.emitter.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text,
      },
    } satisfies acp.SessionUpdate);
  }

  info(text: string): void {
    this.assertNotCancelled?.();
    this.emitNoticePanel("info", text);
  }

  warning(text: string): void {
    this.assertNotCancelled?.();
    this.emitNoticePanel("warning", text);
  }

  error(text: string): void {
    this.assertNotCancelled?.();
    this.emitNoticePanel("error", text);
  }

  status(params: UiStatusParams): void {
    this.assertNotCancelled?.();
    const procedure = params.procedure?.trim() || this.procedureName;
    const event = {
      type: "status" as const,
      procedure,
      message: params.message,
      phase: params.phase,
      iteration: params.iteration,
      autoApprove: params.autoApprove,
      waiting: params.waiting,
    };
    const display = formatProcedureStatusText(event);

    this.log(display);

    if (this.emitter.emitUiEvent) {
      this.emitter.emitUiEvent(event);
      return;
    }

    this.text(`${display}\n`);
  }

  card(params: UiCardParams): void {
    this.assertNotCancelled?.();
    this.panel({
      rendererId: "nb/card@1",
      severity: "info",
      payload: {
        kind: params.kind,
        title: params.title,
        markdown: params.markdown,
      },
    });
  }

  panel(params: UiProcedurePanelParams | UiPanelParams): void {
    this.assertNotCancelled?.();
    if (isLegacyPanelParams(params)) {
      this.emitLegacyPanel(params);
      return;
    }
    this.emitProcedurePanel(params);
  }

  private emitProcedurePanel(params: UiProcedurePanelParams): void {
    const severity = params.severity ?? "info";
    const dismissible = params.dismissible ?? (severity !== "error");
    const event = {
      type: "procedure_panel" as const,
      procedure: this.procedureName,
      rendererId: params.rendererId,
      payload: params.payload,
      severity,
      dismissible,
      ...(params.key !== undefined ? { key: params.key } : {}),
    };

    this.log(
      `[panel] /${event.procedure} ${event.rendererId} severity=${event.severity}${event.key ? ` key=${event.key}` : ""}`,
    );

    if (this.emitter.emitUiEvent) {
      this.emitter.emitUiEvent(event);
      return;
    }

    this.text(`[${event.rendererId}]${event.key ? ` ${event.key}` : ""}\n`);
  }

  private emitLegacyPanel(params: UiPanelParams): void {
    const event = {
      type: "ui_panel" as const,
      procedure: this.procedureName,
      rendererId: params.rendererId,
      slot: params.slot,
      ...(params.key !== undefined ? { key: params.key } : {}),
      payload: params.payload,
      lifetime: params.lifetime ?? "run",
    };

    this.log(`[panel] /${event.procedure} ${event.rendererId}${event.key ? ` key=${event.key}` : ""}`);

    if (this.emitter.emitUiEvent) {
      this.emitter.emitUiEvent(event);
      return;
    }

    this.text(`[${event.rendererId}]${event.key ? ` ${event.key}` : ""}\n`);
  }

  private emitNoticePanel(tone: NoticeTone, text: string): void {
    const normalized = normalizeNoticeText(text);
    this.log(`${NOTICE_LABELS[tone]}: ${normalized}`);

    if (this.emitter.emitUiEvent) {
      const severity = tone === "warning" ? "warn" : tone;
      this.emitter.emitUiEvent({
        type: "procedure_panel",
        procedure: this.procedureName,
        rendererId: "nb/notice@1",
        severity,
        dismissible: severity !== "error",
        payload: {
          message: normalized,
          severity,
        },
      });
      return;
    }

    this.emitter.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `${NOTICE_LABELS[tone]}: ${normalized}`,
      },
    } satisfies acp.SessionUpdate);
  }

  private log(text: string): void {
    this.logger.write({
      spanId: this.spanId,
      parentSpanId: undefined,
      procedure: this.procedureName,
      kind: "print",
      raw: text,
    });
  }
}

function normalizeNoticeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLegacyPanelParams(
  params: UiProcedurePanelParams | UiPanelParams,
): params is UiPanelParams {
  return typeof (params as UiPanelParams).slot === "string";
}
