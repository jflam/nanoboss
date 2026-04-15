import type * as acp from "@agentclientprotocol/sdk";

import type { RunLogger } from "./logger.ts";
import type { SessionUpdateEmitter } from "./context-shared.ts";
import { formatProcedureStatusText } from "./ui-cli.ts";
import type { UiApi, UiCardParams, UiStatusParams } from "./ui-api.ts";
import type { SessionStore } from "@nanoboss/store";

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
  ) {}

  text(text: string): void {
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
    this.emitNotice("info", text);
  }

  warning(text: string): void {
    this.emitNotice("warning", text);
  }

  error(text: string): void {
    this.emitNotice("error", text);
  }

  status(params: UiStatusParams): void {
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
    const event = {
      type: "card" as const,
      procedure: this.procedureName,
      kind: params.kind,
      title: params.title,
      markdown: params.markdown,
    };

    this.log(renderCardLogText(event));

    if (this.emitter.emitUiEvent) {
      this.emitter.emitUiEvent(event);
      return;
    }

    this.text(renderCardFallbackText(event));
  }

  private emitNotice(tone: NoticeTone, text: string): void {
    this.log(`${NOTICE_LABELS[tone]}: ${text}`);
    this.emitter.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `${NOTICE_LABELS[tone]}: ${normalizeNoticeText(text)}`,
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

function renderCardLogText(params: {
  procedure: string;
  kind: UiCardParams["kind"];
  title: string;
  markdown: string;
}): string {
  return `[card] /${params.procedure} ${params.kind}: ${params.title}`;
}

function renderCardFallbackText(params: {
  procedure: string;
  kind: UiCardParams["kind"];
  title: string;
  markdown: string;
}): string {
  return [
    `[${params.kind}] ${params.title}`,
    "",
    params.markdown.trim(),
    "",
  ].join("\n");
}
