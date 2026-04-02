import readline from "node:readline/promises";

import {
  isCommandsUpdatedEvent,
  isRunFailedEvent,
  isTextDeltaEvent,
  isToolStartedEvent,
  isToolUpdatedEvent,
  type FrontendCommand,
  type FrontendEventEnvelope,
} from "./src/frontend-events.ts";

const HTTP_RUN_START_TIMEOUT_MS = Number(process.env.NANOBOSS_HTTP_RUN_START_TIMEOUT_MS ?? "10000");
const HTTP_RUN_IDLE_TIMEOUT_MS = Number(process.env.NANOBOSS_HTTP_RUN_IDLE_TIMEOUT_MS ?? "30000");
const HTTP_RUN_HARD_TIMEOUT_MS = Number(process.env.NANOBOSS_HTTP_RUN_HARD_TIMEOUT_MS ?? String(30 * 60 * 1000));

interface TrackedHttpRun {
  done: boolean;
  startedAt: number;
  lastActivityAt: number;
  waiters: Array<() => void>;
}

class HttpRunTracker {
  private readonly startedRunIds: string[] = [];
  private readonly startWaiters: Array<(runId: string) => void> = [];
  private readonly runs = new Map<string, TrackedHttpRun>();

  observe(event: FrontendEventEnvelope): void {
    const runId = getRunId(event);
    if (!runId) {
      return;
    }

    const now = Date.now();
    const run = this.runs.get(runId) ?? {
      done: false,
      startedAt: now,
      lastActivityAt: now,
      waiters: [],
    };
    run.lastActivityAt = now;

    if (event.type === "run_started") {
      run.startedAt = now;
      const next = this.startWaiters.shift();
      if (next) {
        next(runId);
      } else {
        this.startedRunIds.push(runId);
      }
    }

    if (event.type === "run_completed" || event.type === "run_failed") {
      run.done = true;
    }

    this.runs.set(runId, run);

    for (const waiter of run.waiters.splice(0)) {
      waiter();
    }
  }

  async waitForNextRunStart(timeoutMs = HTTP_RUN_START_TIMEOUT_MS): Promise<string> {
    const existing = this.startedRunIds.shift();
    if (existing) {
      return existing;
    }

    return withTimeout(
      new Promise<string>((resolve) => {
        this.startWaiters.push(resolve);
      }),
      timeoutMs,
      "Timed out waiting for run start",
    );
  }

  async waitForRunCompletion(
    runId: string,
    idleTimeoutMs = HTTP_RUN_IDLE_TIMEOUT_MS,
    hardTimeoutMs = HTTP_RUN_HARD_TIMEOUT_MS,
  ): Promise<void> {
    for (;;) {
      const run = this.runs.get(runId);
      if (run?.done) {
        return;
      }

      const now = Date.now();
      const lastActivityAt = run?.lastActivityAt ?? now;
      const startedAt = run?.startedAt ?? now;
      const idleRemainingMs = idleTimeoutMs - (now - lastActivityAt);
      const hardRemainingMs = hardTimeoutMs - (now - startedAt);
      const waitMs = Math.min(idleRemainingMs, hardRemainingMs);

      if (hardRemainingMs <= 0) {
        throw new Error(`Timed out waiting for run completion: ${runId}`);
      }

      if (idleRemainingMs <= 0) {
        throw new Error(`Timed out waiting for run activity: ${runId}`);
      }

      await Promise.race([
        new Promise<void>((resolve) => {
          const current = this.runs.get(runId) ?? {
            done: false,
            startedAt: now,
            lastActivityAt: now,
            waiters: [],
          };
          current.waiters.push(resolve);
          this.runs.set(runId, current);
        }),
        Bun.sleep(waitMs),
      ]);
    }
  }
}

function getRunId(event: FrontendEventEnvelope): string | undefined {
  if (event.type === "commands_updated") {
    return undefined;
  }

  return event.data.runId;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
import {
  createHttpSession,
  sendSessionPrompt,
  startSessionEventStream,
} from "./src/http-client.ts";
import { DEFAULT_HTTP_SERVER_URL } from "./src/defaults.ts";
import { ensureMatchingHttpServer } from "./src/http-server-supervisor.ts";
import { StreamingTerminalMarkdownRenderer } from "./src/terminal-markdown.ts";
import { parseCliOptions } from "./src/cli-options.ts";
import {
  buildModelCommand,
  isInteractiveModelPickerEnabled,
  promptForModelCommand,
} from "./src/cli-model-picker.ts";
import {
  resolveDownstreamAgentConfig,
  toDownstreamAgentSelection,
} from "./src/config.ts";
import {
  isKnownAgentProvider,
  isKnownModelSelection,
} from "./src/model-catalog.ts";
import {
  formatAgentBanner,
  getCliStartupBanner,
  getDefaultAgentBanner,
} from "./src/runtime-banner.ts";
import { getAgentTokenUsagePercent } from "./src/token-usage.ts";
import type { AgentTokenUsage, DownstreamAgentSelection } from "./src/types.ts";

const LOCAL_CLI_COMMANDS = ["/new", "/end", "/quit", "/exit"] as const;

class OutputClient {
  availableCommands: string[] = [...LOCAL_CLI_COMMANDS];
  private readonly toolMeta = new Map<string, { title: string; depth: number; isWrapper: boolean }>();
  private readonly activeWrapperToolCallIds: string[] = [];
  private readonly responseWaiters: Array<() => void> = [];
  private readonly runStartedAt = new Map<string, number>();
  private readonly runLastHeartbeatLineAt = new Map<string, number>();
  private markdownRenderer?: StreamingTerminalMarkdownRenderer;
  private responseActive = false;
  private outputEndsWithNewline = true;
  private pendingTurnTokenUsage?: AgentTokenUsage;
  private currentAgentBanner = getDefaultAgentBanner(process.cwd());
  private currentAgentSelection = toDownstreamAgentSelection(
    resolveDownstreamAgentConfig(process.cwd()),
  );

  constructor(private readonly options: { showToolCalls: boolean }) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const selected =
      params.options.find((option) => option.kind.startsWith("allow")) ??
      params.options[0];

    if (!selected) {
      return { outcome: { outcome: "cancelled" } };
    }

    return {
      outcome: {
        outcome: "selected",
        optionId: selected.optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.writeOutput(update.content.text);
        }
        break;
      case "tool_call":
        if (this.options.showToolCalls) {
          this.startToolCall(update.toolCallId, update.title);
        }
        break;
      case "tool_call_update":
        if (update.status === "completed") {
          const usage = extractTokenUsage(update.rawOutput);
          const toolTitle = this.toolMeta.get(update.toolCallId)?.title;
          if (usage && toolTitle && toolTitle.startsWith("defaultSession:")) {
            this.pendingTurnTokenUsage = usage;
          }
        }
        if (this.options.showToolCalls && update.status) {
          this.updateToolCall(update.toolCallId, update.status, update.title ?? undefined);
        }
        break;
      case "available_commands_update":
        this.setCommands(update.availableCommands.map((command) => ({
          name: command.name,
          description: command.description,
          inputHint: command.input?.hint,
        })));
        break;
      default:
        break;
    }
  }

  handleFrontendEvent(event: FrontendEventEnvelope): void {
    if (isCommandsUpdatedEvent(event)) {
      this.setCommands(event.data.commands);
      return;
    }

    if (event.type === "run_started") {
      this.runStartedAt.set(event.data.runId, Date.parse(event.data.startedAt) || Date.now());
      this.runLastHeartbeatLineAt.delete(event.data.runId);
      this.beginResponse();
      return;
    }

    if (isTextDeltaEvent(event)) {
      this.writeOutput(event.data.text);
      return;
    }

    if (event.type === "run_heartbeat") {
      this.handleRunHeartbeat(event.data.runId, event.data.procedure, event.data.at);
      return;
    }

    if (isToolStartedEvent(event)) {
      if (this.options.showToolCalls) {
        this.startToolCall(event.data.toolCallId, event.data.title);
      }
      return;
    }

    if (isToolUpdatedEvent(event)) {
      if (!this.options.showToolCalls) {
        return;
      }

      this.updateToolCall(event.data.toolCallId, event.data.status, event.data.title);
      return;
    }

    if (event.type === "run_completed") {
      this.runStartedAt.delete(event.data.runId);
      this.runLastHeartbeatLineAt.delete(event.data.runId);
      if (event.data.procedure === "default" && event.data.tokenUsage) {
        this.pendingTurnTokenUsage = event.data.tokenUsage;
      }
      this.endResponse();
      return;
    }

    if (isRunFailedEvent(event)) {
      this.runStartedAt.delete(event.data.runId);
      this.runLastHeartbeatLineAt.delete(event.data.runId);
      this.endResponse();
      this.writeToolLine(`[run] ${event.data.error}`);
    }
  }

  setCommands(commands: FrontendCommand[]): void {
    this.availableCommands = uniqueStrings([
      ...commands.map((command) => `/${command.name}`),
      ...LOCAL_CLI_COMMANDS,
    ]);
  }

  setCurrentAgentBanner(text: string): void {
    this.currentAgentBanner = text;
  }

  getCurrentAgentBanner(): string {
    return this.currentAgentBanner;
  }

  setCurrentAgentSelection(selection: DownstreamAgentSelection | undefined): void {
    this.currentAgentSelection = selection;
    if (selection) {
      this.currentAgentBanner = formatAgentBanner(
        resolveDownstreamAgentConfig(process.cwd(), selection),
      );
    }
  }

  getCurrentAgentSelection(): DownstreamAgentSelection | undefined {
    return this.currentAgentSelection;
  }

  completer = (line: string): [string[], string] => {
    const matches = this.availableCommands.filter((command) => command.startsWith(line));
    return [matches.length > 0 ? matches : this.availableCommands, line];
  };

  beginResponse(): void {
    this.endResponse();
    this.pendingTurnTokenUsage = undefined;
    this.markdownRenderer = new StreamingTerminalMarkdownRenderer();
    this.responseActive = true;
  }

  endResponse(): void {
    if (this.markdownRenderer) {
      const tail = this.markdownRenderer.finish();
      this.markdownRenderer = undefined;

      if (tail.length > 0) {
        process.stdout.write(tail);
        this.outputEndsWithNewline = tail.endsWith("\n");
      }
    }

    if (!this.responseActive) {
      return;
    }

    if (this.pendingTurnTokenUsage) {
      this.writeToolLine(formatTokenUsageLine(this.pendingTurnTokenUsage));
      this.pendingTurnTokenUsage = undefined;
    }

    this.responseActive = false;
    for (const waiter of this.responseWaiters.splice(0)) {
      waiter();
    }
  }

  waitForResponseEnd(): Promise<void> {
    if (!this.responseActive) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.responseWaiters.push(resolve);
    });
  }

  private handleRunHeartbeat(runId: string, procedure: string, at: string): void {
    const now = Date.parse(at) || Date.now();
    const lastPrintedAt = this.runLastHeartbeatLineAt.get(runId) ?? 0;
    if (now - lastPrintedAt < 1_000) {
      return;
    }

    this.runLastHeartbeatLineAt.set(runId, now);
    const startedAt = this.runStartedAt.get(runId) ?? now;
    const elapsedSeconds = Math.max(1, Math.round((now - startedAt) / 1_000));
    this.writeToolLine(`[run] ${procedure} still working (${elapsedSeconds}s)`);
  }

  private writeOutput(text: string): void {
    if (!this.markdownRenderer) {
      process.stdout.write(text);
      this.outputEndsWithNewline = text.endsWith("\n");
      return;
    }

    const rendered = this.markdownRenderer.push(text);
    if (rendered.length === 0) {
      return;
    }

    process.stdout.write(rendered);
    this.outputEndsWithNewline = rendered.endsWith("\n");
  }

  writeLineBreak(): void {
    if (!this.outputEndsWithNewline) {
      this.writeOutput("\n");
    }
  }

  writeStatusLine(text: string): void {
    this.writeToolLine(text);
  }

  private writeToolLine(text: string): void {
    const prefix = this.outputEndsWithNewline ? "" : "\n";
    process.stderr.write(`${prefix}${text}\n`);
    this.outputEndsWithNewline = true;
  }

  private startToolCall(toolCallId: string, title: string): void {
    const depth = this.activeWrapperToolCallIds.length;
    const isWrapper = isWrapperToolTitle(title);
    this.toolMeta.set(toolCallId, { title, depth, isWrapper });
    this.writeToolLine(formatToolTraceLine(depth, `[tool] ${title}`));

    if (isWrapper) {
      this.activeWrapperToolCallIds.push(toolCallId);
    }
  }

  private updateToolCall(toolCallId: string, status: string, title?: string): void {
    const existing = this.toolMeta.get(toolCallId);
    const resolvedTitle = title ?? existing?.title ?? toolCallId;
    const resolvedDepth = existing?.depth ?? this.activeWrapperToolCallIds.length;
    const isWrapper = existing?.isWrapper ?? isWrapperToolTitle(resolvedTitle);

    this.toolMeta.set(toolCallId, {
      title: resolvedTitle,
      depth: resolvedDepth,
      isWrapper,
    });

    if (status === "completed") {
      this.finishToolCall(toolCallId);
      return;
    }

    if (status === "pending") {
      return;
    }

    if (status === "failed") {
      this.writeToolLine(formatToolTraceLine(resolvedDepth, `[tool] ${resolvedTitle} failed`));
      this.finishToolCall(toolCallId);
      return;
    }

    this.writeToolLine(formatToolTraceLine(resolvedDepth, `[tool] ${resolvedTitle} ${status}`));
  }

  private finishToolCall(toolCallId: string): void {
    const existing = this.toolMeta.get(toolCallId);
    if (existing?.isWrapper) {
      removeFirstMatch(this.activeWrapperToolCallIds, toolCallId);
    }
    this.toolMeta.delete(toolCallId);
  }
}

function isWrapperToolTitle(title: string): boolean {
  return title.startsWith("callAgent") || title.startsWith("defaultSession:");
}

function formatToolTraceLine(depth: number, text: string): string {
  return `${"│ ".repeat(depth)}${text}`;
}

function removeFirstMatch(values: string[], needle: string): void {
  const index = values.indexOf(needle);
  if (index >= 0) {
    values.splice(index, 1);
  }
}

function extractTokenUsage(rawOutput: unknown): AgentTokenUsage | undefined {
  if (!rawOutput || typeof rawOutput !== "object" || !("tokenUsage" in rawOutput)) {
    return undefined;
  }

  const usage = (rawOutput as { tokenUsage?: unknown }).tokenUsage;
  if (!usage || typeof usage !== "object" || !("source" in usage) || typeof usage.source !== "string") {
    return undefined;
  }

  return usage as AgentTokenUsage;
}

function formatTokenUsageLine(usage: AgentTokenUsage): string {
  if (usage.currentContextTokens !== undefined && usage.maxContextTokens !== undefined) {
    const percent = getAgentTokenUsagePercent(usage) ?? 0;
    return `[tokens] ${formatInt(usage.currentContextTokens)} / ${formatInt(usage.maxContextTokens)} (${percent.toFixed(1)}%)`;
  }

  if (usage.currentContextTokens !== undefined) {
    return `[tokens] ${formatInt(usage.currentContextTokens)}`;
  }

  return `[tokens] ${usage.source}`;
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export async function runCliCommand(argv: string[] = []): Promise<void> {
  const options = parseCliOptions(argv);
  if (options.showHelp) {
    printHelp();
    return;
  }

  await runHttpCli(options.serverUrl, options.showToolCalls);
}

async function runHttpCli(serverUrl: string, showToolCalls: boolean): Promise<void> {
  const client = new OutputClient({ showToolCalls });
  await ensureMatchingHttpServer(serverUrl, {
    cwd: process.cwd(),
    onStatus: (text) => client.writeStatusLine(text),
  });

  let tracker = new HttpRunTracker();
  let session = await createHttpSession(
    serverUrl,
    process.cwd(),
    client.getCurrentAgentSelection(),
  );
  client.setCommands(session.commands);
  client.setCurrentAgentBanner(session.agentLabel);
  client.setCurrentAgentSelection(session.defaultAgentSelection);
  writeStartupBanner(`${session.buildLabel} ${session.agentLabel}`);

  let stream = startSessionEventStream({
    baseUrl: serverUrl,
    sessionId: session.sessionId,
    onEvent: (event) => {
      tracker.observe(event);
      client.handleFrontendEvent(event);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[stream] ${message}\n`);
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: client.completer,
  });

  try {
    for (;;) {
      const line = await rl.question("> ");
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (isExitRequest(trimmed)) {
        announceSessionId(client, session.sessionId);
        break;
      }
      if (isNewSessionRequest(trimmed)) {
        stream.close();
        tracker = new HttpRunTracker();
        session = await createHttpSession(
          serverUrl,
          process.cwd(),
          client.getCurrentAgentSelection(),
        );
        client.setCommands(session.commands);
        client.setCurrentAgentBanner(session.agentLabel);
        client.setCurrentAgentSelection(session.defaultAgentSelection);
        stream = startSessionEventStream({
          baseUrl: serverUrl,
          sessionId: session.sessionId,
          onEvent: (event) => {
            tracker.observe(event);
            client.handleFrontendEvent(event);
          },
          onError: (error) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[stream] ${message}\n`);
          },
        });
        client.writeStatusLine(`[session] new ${session.sessionId}`);
        continue;
      }

      const prompt = await maybeResolveInteractiveCommand(line, rl, client);
      if (!prompt) {
        continue;
      }

      await sendSessionPrompt(serverUrl, session.sessionId, prompt);
      const runId = await tracker.waitForNextRunStart();
      await tracker.waitForRunCompletion(runId);
      await client.waitForResponseEnd();
      client.writeLineBreak();
    }
  } finally {
    stream.close();
    rl.close();
  }
}

function isExitRequest(trimmed: string): boolean {
  return trimmed === "exit" || trimmed === "quit" || trimmed === "/end" || trimmed === "/quit" || trimmed === "/exit";
}

function isNewSessionRequest(trimmed: string): boolean {
  return trimmed === "/new";
}

function announceSessionId(client: OutputClient, sessionId: string): void {
  client.writeStatusLine(`nanoboss session id: ${sessionId}`);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function maybeResolveInteractiveCommand(
  line: string,
  rl: { question(query: string): Promise<string> },
  client: OutputClient,
): Promise<string | undefined> {
  const trimmed = line.trim();
  if (trimmed === "/model" && isInteractiveModelPickerEnabled()) {
    const selection = await promptForModelCommand(rl, client.getCurrentAgentBanner());
    if (!selection) {
      return undefined;
    }

    client.setCurrentAgentSelection(selection);
    return buildModelCommand(selection.provider, selection.model);
  }

  const selection = parseModelSelectionCommand(trimmed);
  if (selection) {
    client.setCurrentAgentSelection(selection);
  }

  return line;
}

function parseModelSelectionCommand(line: string): DownstreamAgentSelection | undefined {
  if (!line.startsWith("/model ")) {
    return undefined;
  }

  const [, rawProvider, ...rest] = line.split(/\s+/);
  if (!rawProvider || !isKnownAgentProvider(rawProvider)) {
    return undefined;
  }

  const model = rest.join(" ").trim();
  if (!model || !isKnownModelSelection(rawProvider, model)) {
    return undefined;
  }

  return {
    provider: rawProvider,
    model,
  };
}

function writeStartupBanner(text: string): void {
  process.stderr.write(`${text}\n`);
}

function printHelp(): void {
  process.stdout.write([
    "Usage: nanoboss cli [--tool-calls|--no-tool-calls] [--server-url <url>]",
    "",
    "Options:",
    "  --tool-calls          Show tool call progress lines (default)",
    "  --no-tool-calls       Hide tool call progress lines",
    `  --server-url <url>    Connect to nanoboss over HTTP/SSE (default: ${DEFAULT_HTTP_SERVER_URL})`,
    "  -h, --help            Show this help text",
    "",
  ].join("\n"));
}

if (import.meta.main) {
  await runCliCommand(Bun.argv.slice(2));
}
