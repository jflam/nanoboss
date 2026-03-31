import type * as acp from "@agentclientprotocol/sdk";

export interface DownstreamAgentConfig {
  provider?: DownstreamAgentProvider;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
  reasoningEffort?: string;
}

export type DownstreamAgentProvider = "claude" | "gemini" | "codex" | "copilot";

export interface DownstreamAgentSelection {
  provider: DownstreamAgentProvider;
  model?: string;
}

export interface TypeDescriptor<T> {
  schema: object;
  validate: (input: unknown) => input is T;
}

export interface AgentResult<T> {
  value: T;
  logFile?: string;
  durationMs: number;
  raw: string;
}

export interface Procedure {
  name: string;
  description: string;
  inputHint?: string;
  execute(prompt: string, ctx: CommandContext): Promise<string | void>;
}

export interface ProcedureRegistryLike {
  get(name: string): Procedure | undefined;
  register(procedure: Procedure): void;
  loadProcedureFromPath(path: string): Promise<Procedure>;
  persist(procedure: Procedure, source: string): Promise<string>;
  toAvailableCommands(): acp.AvailableCommand[];
}

export interface CommandContext {
  readonly cwd: string;
  callAgent<T = string>(
    prompt: string,
    descriptor?: TypeDescriptor<T>,
    options?: CommandCallAgentOptions,
  ): Promise<AgentResult<T>>;
  callProcedure(name: string, prompt: string): Promise<string | void>;
  print(text: string): void;
}

export interface CommandCallAgentOptions {
  agent?: DownstreamAgentSelection;
  stream?: boolean;
}

export interface LogEntry {
  timestamp: string;
  runId: string;
  spanId: string;
  parentSpanId?: string;
  procedure: string;
  kind: "procedure_start" | "procedure_end" | "agent_start" | "agent_end" | "print";
  prompt?: string;
  result?: unknown;
  raw?: string;
  durationMs?: number;
  error?: string;
  agentLogFile?: string;
  agentProvider?: DownstreamAgentProvider;
  agentModel?: string;
}

export interface CallAgentOptions {
  config?: DownstreamAgentConfig;
  onUpdate?: (update: acp.SessionUpdate) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface CallAgentTransport {
  invoke(prompt: string, options: CallAgentOptions): Promise<{
    raw: string;
    logFile?: string;
    updates: acp.SessionUpdate[];
  }>;
}
