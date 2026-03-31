import type * as acp from "@agentclientprotocol/sdk";

import { callAgent } from "./call-agent.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import type { RunLogger } from "./logger.ts";
import type {
  AgentResult,
  CommandCallAgentOptions,
  CommandContext,
  DownstreamAgentSelection,
  ProcedureRegistryLike,
  TypeDescriptor,
} from "./types.ts";

interface OutputState {
  hasOutput: boolean;
}

export interface SessionUpdateEmitter {
  emit(update: acp.SessionUpdate): void;
  flush(): Promise<void>;
}

interface CommandContextParams {
  cwd: string;
  logger: RunLogger;
  registry: ProcedureRegistryLike;
  procedureName: string;
  spanId: string;
  emitter: SessionUpdateEmitter;
  outputState?: OutputState;
  signal?: AbortSignal;
}

export class CommandContextImpl implements CommandContext {
  readonly cwd: string;

  private readonly logger: RunLogger;
  private readonly registry: ProcedureRegistryLike;
  private readonly procedureName: string;
  private readonly spanId: string;
  private readonly emitter: SessionUpdateEmitter;
  private readonly outputState: OutputState;
  private readonly signal?: AbortSignal;

  constructor(params: CommandContextParams) {
    this.cwd = params.cwd;
    this.logger = params.logger;
    this.registry = params.registry;
    this.procedureName = params.procedureName;
    this.spanId = params.spanId;
    this.emitter = params.emitter;
    this.outputState = params.outputState ?? { hasOutput: false };
    this.signal = params.signal;
  }

  get hasOutput(): boolean {
    return this.outputState.hasOutput;
  }

  async callAgent<T = string>(
    prompt: string,
    descriptor?: TypeDescriptor<T>,
    options?: CommandCallAgentOptions,
  ): Promise<AgentResult<T>> {
    const childSpanId = this.logger.newSpan(this.spanId);
    const startedAt = Date.now();
    const toolCallId = crypto.randomUUID();
    const agentLabel = formatAgentLabel(options?.agent);

    this.logger.write({
      spanId: childSpanId,
      parentSpanId: this.spanId,
      procedure: this.procedureName,
      kind: "agent_start",
      prompt,
      agentProvider: options?.agent?.provider,
      agentModel: options?.agent?.model,
    });

    this.emitter.emit({
      sessionUpdate: "tool_call",
      toolCallId,
      title: `callAgent${agentLabel}: ${summarize(prompt)}`,
      kind: "other",
      status: "pending",
      rawInput: { prompt, agent: options?.agent },
    });

    try {
      const result = await callAgent(prompt, descriptor, {
        config: resolveDownstreamAgentConfig(this.cwd, options?.agent),
        signal: this.signal,
        onUpdate: async (update) => {
          if (
            options?.stream !== false &&
            (
              update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update"
            )
          ) {
            this.emitter.emit(update);
          }

          if (
            options?.stream !== false &&
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          ) {
            this.outputState.hasOutput = true;
          }
        },
      });

      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: this.procedureName,
        kind: "agent_end",
        durationMs: Date.now() - startedAt,
        result: descriptor ? result.value : undefined,
        raw: result.raw,
        agentLogFile: result.logFile,
        agentProvider: options?.agent?.provider,
        agentModel: options?.agent?.model,
      });

      this.emitter.emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: {
          durationMs: result.durationMs,
          logFile: result.logFile,
        },
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: this.procedureName,
        kind: "agent_end",
        durationMs: Date.now() - startedAt,
        error: message,
        agentProvider: options?.agent?.provider,
        agentModel: options?.agent?.model,
      });

      this.emitter.emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { error: message },
      });

      throw error;
    }
  }

  async callProcedure(name: string, prompt: string): Promise<string | void> {
    const procedure = this.registry.get(name);
    if (!procedure) {
      throw new Error(`Unknown procedure: ${name}`);
    }

    const childSpanId = this.logger.newSpan(this.spanId);
    const startedAt = Date.now();

    this.logger.write({
      spanId: childSpanId,
      parentSpanId: this.spanId,
      procedure: name,
      kind: "procedure_start",
      prompt,
    });

    try {
      const childContext = new CommandContextImpl({
        cwd: this.cwd,
        logger: this.logger,
        registry: this.registry,
        procedureName: name,
        spanId: childSpanId,
        emitter: this.emitter,
        outputState: this.outputState,
        signal: this.signal,
      });
      const result = await procedure.execute(prompt, childContext);

      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: name,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        raw: typeof result === "string" ? result : undefined,
      });

      return result;
    } catch (error) {
      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: name,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  print(text: string): void {
    this.outputState.hasOutput = true;
    this.logger.write({
      spanId: this.spanId,
      parentSpanId: undefined,
      procedure: this.procedureName,
      kind: "print",
      raw: text,
    });
    this.emitter.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text,
      },
    });
  }
}

function summarize(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
}

function formatAgentLabel(agent?: DownstreamAgentSelection): string {
  if (!agent) {
    return "";
  }

  return agent.model ? ` [${agent.provider}:${agent.model}]` : ` [${agent.provider}]`;
}
