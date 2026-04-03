import readline from "node:readline/promises";

import {
  isRunFailedEvent,
  isTextDeltaEvent,
  isToolStartedEvent,
  isToolUpdatedEvent,
  type FrontendEventEnvelope,
} from "./frontend-events.ts";

const HTTP_RUN_START_TIMEOUT_MS = Number(process.env.NANOBOSS_HTTP_RUN_START_TIMEOUT_MS ?? "10000");
const HTTP_RUN_IDLE_TIMEOUT_MS = Number(process.env.NANOBOSS_HTTP_RUN_IDLE_TIMEOUT_MS ?? "30000");
const HTTP_RUN_HARD_TIMEOUT_MS = Number(process.env.NANOBOSS_HTTP_RUN_HARD_TIMEOUT_MS ?? String(30 * 60 * 1000));
const READLINE_CLOSED_MESSAGE = "readline was closed";

interface PromptReader {
  question(query: string): Promise<string>;
}

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
  resumeHttpSession,
  sendSessionPrompt,
  startSessionEventStream,
} from "./http-client.ts";
import {
  isExitRequest,
  isNewSessionRequest,
  parseModelSelectionCommand,
} from "./tui/commands.ts";
import {
  formatMemoryCardsLines,
  formatPromptDiagnosticsLine,
  formatStoredMemoryCardLines,
  formatTokenUsageLine,
  formatToolTraceLine,
  isWrapperToolTitle,
} from "./tui/format.ts";
import { getBuildFreshnessNotice } from "./build-freshness.ts";
import { ensureMatchingHttpServer } from "./http-server-supervisor.ts";
import { StreamingTerminalMarkdownRenderer } from "./terminal-markdown.ts";
import { buildModelCommand } from "./model-command.ts";
import {
  resolveDownstreamAgentConfig,
  toDownstreamAgentSelection,
} from "./config.ts";
import type { AgentTokenUsage, DownstreamAgentSelection } from "./types.ts";

class OutputClient {
  private readonly toolMeta = new Map<string, { title: string; depth: number; isWrapper: boolean }>();
  private readonly activeWrapperToolCallIds: string[] = [];
  private readonly responseWaiters: Array<() => void> = [];
  private readonly runStartedAt = new Map<string, number>();
  private readonly runLastHeartbeatLineAt = new Map<string, number>();
  private markdownRenderer?: StreamingTerminalMarkdownRenderer;
  private responseActive = false;
  private outputEndsWithNewline = true;
  private pendingTurnTokenUsage?: AgentTokenUsage;
  private currentAgentSelection = toDownstreamAgentSelection(
    resolveDownstreamAgentConfig(process.cwd()),
  );

  constructor(private readonly options: { showToolCalls: boolean }) {}

  handleFrontendEvent(event: FrontendEventEnvelope): void {
    if (event.type === "run_started") {
      this.runStartedAt.set(event.data.runId, Date.parse(event.data.startedAt) || Date.now());
      this.runLastHeartbeatLineAt.delete(event.data.runId);
      this.beginResponse();
      return;
    }

    if (event.type === "memory_cards") {
      if (this.options.showToolCalls) {
        for (const line of formatMemoryCardsLines(event.data.cards)) {
          this.writeToolLine(line);
        }
      }
      return;
    }

    if (event.type === "memory_card_stored") {
      if (this.options.showToolCalls) {
        for (const line of formatStoredMemoryCardLines(event.data.card, {
          method: event.data.estimateMethod,
          encoding: event.data.estimateEncoding,
        })) {
          this.writeToolLine(line);
        }
      }
      return;
    }

    if (event.type === "prompt_diagnostics") {
      if (this.options.showToolCalls) {
        this.writeToolLine(formatPromptDiagnosticsLine(event.data.diagnostics));
      }
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
      if (event.data.tokenUsage) {
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

  setCurrentAgentSelection(selection: DownstreamAgentSelection | undefined): void {
    this.currentAgentSelection = selection;
  }

  getCurrentAgentSelection(): DownstreamAgentSelection | undefined {
    return this.currentAgentSelection;
  }

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

function removeFirstMatch(values: string[], needle: string): void {
  const index = values.indexOf(needle);
  if (index >= 0) {
    values.splice(index, 1);
  }
}

export async function readPromptInput(
  rl: PromptReader,
  options: {
    prompt?: string;
  } = {},
): Promise<string> {
  try {
    return await rl.question(options.prompt ?? "> ");
  } catch (error) {
    if (isReadlineClosedError(error)) {
      throw new Error(READLINE_CLOSED_MESSAGE);
    }
    throw error;
  }
}

export async function runLegacyHttpCli(params: {
  serverUrl: string;
  showToolCalls: boolean;
  sessionId?: string;
}): Promise<void> {
  const client = new OutputClient({ showToolCalls: params.showToolCalls });
  const serverUrl = params.serverUrl;
  const buildFreshnessNotice = getBuildFreshnessNotice(process.cwd());
  if (buildFreshnessNotice) {
    client.writeStatusLine(buildFreshnessNotice);
  }
  await ensureMatchingHttpServer(serverUrl, {
    cwd: process.cwd(),
    onStatus: (text) => client.writeStatusLine(text),
  });

  let tracker = new HttpRunTracker();
  let session = params.sessionId
    ? await resumeHttpSession(
      serverUrl,
      params.sessionId,
      process.cwd(),
    )
    : await createHttpSession(
      serverUrl,
      process.cwd(),
      client.getCurrentAgentSelection(),
    );
  client.setCurrentAgentSelection(session.defaultAgentSelection);
  writeStartupBanner(`${session.buildLabel} ${session.agentLabel}`);
  if (params.sessionId) {
    client.writeStatusLine(`[session] resumed ${session.sessionId}`);
  }

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

  try {
    for (;;) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      let line: string;
      try {
        try {
          line = await readPromptInput(rl);
        } catch (error) {
          if (isReadlineClosedError(error)) {
            announceSessionId(client, session.sessionId);
            break;
          }
          throw error;
        }

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
          await stream.closed;
          tracker = new HttpRunTracker();
          session = await createHttpSession(
            serverUrl,
            process.cwd(),
            client.getCurrentAgentSelection(),
          );
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

        const prompt = maybeResolveCommand(line, client);
        if (!prompt) {
          continue;
        }

        rl.close();
        await sendSessionPrompt(serverUrl, session.sessionId, prompt);
        const runId = await tracker.waitForNextRunStart();
        await tracker.waitForRunCompletion(runId);
        await client.waitForResponseEnd();
        client.writeLineBreak();
      } finally {
        rl.close();
      }
    }
  } finally {
    stream.close();
    await stream.closed;
  }
}

function isReadlineClosedError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === READLINE_CLOSED_MESSAGE ||
    ("code" in error && error.code === "ERR_USE_AFTER_CLOSE")
  );
}

function announceSessionId(client: OutputClient, sessionId: string): void {
  client.writeStatusLine(`nanoboss session id: ${sessionId}`);
}

function maybeResolveCommand(
  line: string,
  client: OutputClient,
): string {
  const trimmed = line.trim();
  const selection = parseModelSelectionCommand(trimmed);
  if (selection) {
    client.setCurrentAgentSelection(selection);
    return buildModelCommand(selection.provider, selection.model);
  }

  return line;
}

function writeStartupBanner(text: string): void {
  process.stderr.write(`${text}\n`);
}

