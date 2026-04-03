import { resolve } from "node:path";

import { getBuildLabel } from "./build-info.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import { readCurrentSessionPointer } from "./current-session.ts";
import { inferDataShape } from "./data-shape.ts";
import { dispatchMcpToolsMethod, type JsonRpcToolMetadata } from "./mcp-jsonrpc.ts";
import {
  ProcedureDispatchJobManager,
  type ProcedureDispatchStartResult,
  type ProcedureDispatchStatusResult,
} from "./procedure-dispatch-jobs.ts";
import { type ProcedureExecutionResult } from "./procedure-runner.ts";
import { ProcedureRegistry } from "./registry.ts";
import { SessionStore } from "./session-store.ts";
import { shouldLoadDiskCommands } from "./runtime-mode.ts";
import type {
  CellDescendantsOptions,
  CellKind,
  CellRecord,
  CellRef,
  DownstreamAgentSelection,
  ProcedureRegistryLike,
  SessionRecentOptions,
  TopLevelRunsOptions,
  ValueRef,
} from "./types.ts";

export const SESSION_MCP_PROTOCOL_VERSION = "2025-11-25";
export const SESSION_MCP_SERVER_NAME = "nanoboss-session";
export const SESSION_MCP_INSTRUCTIONS = "Use these tools to dispatch nanoboss procedures and inspect durable session state for the current master session.";

interface SessionMcpParams {
  sessionId?: string;
  cwd: string;
  rootDir?: string;
  registry?: ProcedureRegistryLike;
}

interface SessionMcpToolDefinition extends JsonRpcToolMetadata {
  parseArgs(args: Record<string, unknown>): unknown;
  call(api: SessionMcpApi, args: unknown): Promise<unknown>;
}

interface ProcedureListResult {
  procedures: SessionProcedureMetadata[];
}

interface SessionProcedureMetadata {
  name: string;
  description: string;
  inputHint?: string;
}

export type ProcedureDispatchResult = ProcedureExecutionResult;
export type ProcedureDispatchStartToolResult = ProcedureDispatchStartResult;
export type ProcedureDispatchStatusToolResult = ProcedureDispatchStatusResult;

export interface SessionSchemaResult {
  target: CellRef | ValueRef;
  dataShape: unknown;
  explicitDataSchema?: object;
}

export class SessionMcpApi {
  private readonly registryPromise: Promise<ProcedureRegistryLike>;
  private defaultAgentConfig: ReturnType<typeof resolveDownstreamAgentConfig>;

  constructor(private readonly params: SessionMcpParams) {
    this.registryPromise = params.registry
      ? Promise.resolve(params.registry)
      : loadSessionMcpRegistry(params.cwd);
    this.defaultAgentConfig = resolveDownstreamAgentConfig(params.cwd);
  }

  sessionRecent(args: SessionRecentOptions & { sessionId?: string } = {}): ReturnType<SessionStore["recent"]> {
    return this.createStore(args.sessionId).recent(args);
  }

  topLevelRuns(args: TopLevelRunsOptions & { sessionId?: string } = {}): ReturnType<SessionStore["topLevelRuns"]> {
    return this.createStore(args.sessionId).topLevelRuns(args);
  }

  cellGet(cellRef: CellRef): CellRecord {
    return this.createStore().readCell(cellRef);
  }

  cellAncestors(
    cellRef: CellRef,
    args: { includeSelf?: boolean; limit?: number } = {},
  ): ReturnType<SessionStore["ancestors"]> {
    return this.createStore().ancestors(cellRef, args);
  }

  cellDescendants(
    cellRef: CellRef,
    args: CellDescendantsOptions = {},
  ): ReturnType<SessionStore["descendants"]> {
    return this.createStore().descendants(cellRef, args);
  }

  refRead(valueRef: ValueRef): unknown {
    return this.createStore().readRef(valueRef);
  }

  refStat(valueRef: ValueRef) {
    return this.createStore().statRef(valueRef);
  }

  refWriteToFile(valueRef: ValueRef, path: string): { path: string } {
    this.createStore().writeRefToFile(valueRef, path, this.params.cwd);
    return { path };
  }

  getSchema(args: { cellRef?: CellRef; valueRef?: ValueRef }): SessionSchemaResult {
    const store = this.createStore();

    if (args.valueRef) {
      const value = store.readRef(args.valueRef);
      return {
        target: args.valueRef,
        dataShape: inferDataShape(value),
      };
    }

    if (!args.cellRef) {
      throw new Error("get_schema requires cellRef or valueRef");
    }

    const cell = store.readCell(args.cellRef);
    return {
      target: args.cellRef,
      dataShape: inferDataShape(cell.output.data),
      explicitDataSchema: cell.output.explicitDataSchema,
    };
  }

  async procedureList(args: { includeHidden?: boolean } = {}): Promise<ProcedureListResult> {
    const registry = await this.getRegistry();
    return {
      procedures: getProcedureList(registry, args.includeHidden === true),
    };
  }

  async procedureGet(args: { name: string }): Promise<SessionProcedureMetadata> {
    const registry = await this.getRegistry();
    const procedure = registry.get(args.name);
    if (!procedure) {
      throw new Error(`Unknown procedure: ${args.name}`);
    }

    return {
      name: procedure.name,
      description: procedure.description,
      inputHint: procedure.inputHint,
    };
  }

  async procedureDispatchStart(args: {
    name: string;
    prompt: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    dispatchCorrelationId?: string;
  }): Promise<ProcedureDispatchStartToolResult> {
    if (args.defaultAgentSelection) {
      this.defaultAgentConfig = resolveDownstreamAgentConfig(this.params.cwd, args.defaultAgentSelection);
    }

    return await this.createDispatchJobManager().start(args);
  }

  async procedureDispatchStatus(args: { dispatchId: string }): Promise<ProcedureDispatchStatusToolResult> {
    return await this.createDispatchJobManager().status(args.dispatchId);
  }

  async procedureDispatchWait(args: {
    dispatchId: string;
    waitMs?: number;
  }): Promise<ProcedureDispatchStatusToolResult> {
    return await this.createDispatchJobManager().wait(args.dispatchId, args.waitMs);
  }

  async procedureDispatch(args: {
    name: string;
    prompt: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    dispatchCorrelationId?: string;
  }): Promise<ProcedureDispatchResult> {
    const started = await this.procedureDispatchStart(args);

    for (;;) {
      const status = await this.procedureDispatchWait({
        dispatchId: started.dispatchId,
      });

      if (status.status === "completed" && status.result) {
        if (status.result.defaultAgentSelection) {
          this.defaultAgentConfig = resolveDownstreamAgentConfig(this.params.cwd, status.result.defaultAgentSelection);
        }
        return status.result;
      }

      if (status.status === "failed") {
        throw new Error(status.error ?? `Procedure dispatch failed: ${status.dispatchId}`);
      }

      if (status.status === "cancelled") {
        throw new Error(`Procedure dispatch cancelled: ${status.dispatchId}`);
      }
    }
  }

  private createStore(sessionId = this.params.sessionId): SessionStore {
    const current = readCurrentSessionPointer();
    const resolvedSessionId = sessionId ?? current?.sessionId;
    const resolvedRootDir = sessionId === undefined && this.params.rootDir === undefined
      ? current?.rootDir
      : this.params.rootDir;

    if (!resolvedSessionId) {
      throw new Error("No active nanoboss session found; provide sessionId explicitly.");
    }

    return new SessionStore({
      sessionId: resolvedSessionId,
      cwd: this.params.cwd,
      rootDir: resolvedRootDir,
    });
  }

  private createDispatchJobManager(): ProcedureDispatchJobManager {
    const store = this.createStore();
    return new ProcedureDispatchJobManager({
      cwd: this.params.cwd,
      sessionId: store.sessionId,
      rootDir: store.rootDir,
      getRegistry: async () => await this.getRegistry(),
    });
  }

  private async getRegistry(): Promise<ProcedureRegistryLike> {
    return await this.registryPromise;
  }
}

export function createSessionMcpApi(params: SessionMcpParams): SessionMcpApi {
  return new SessionMcpApi(params);
}

const CELL_REF_SCHEMA = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    cellId: { type: "string" },
  },
  required: ["sessionId", "cellId"],
  additionalProperties: false,
};

const VALUE_REF_SCHEMA = {
  type: "object",
  properties: {
    cell: CELL_REF_SCHEMA,
    path: { type: "string" },
  },
  required: ["cell", "path"],
  additionalProperties: false,
};

const CELL_KIND_SCHEMA = {
  type: "string",
  enum: ["top_level", "procedure", "agent"],
};

function defineTool<Args>(definition: {
  name: string;
  description: string;
  inputSchema: object;
  parseArgs(args: Record<string, unknown>): Args;
  call(api: SessionMcpApi, args: Args): Promise<unknown>;
}): SessionMcpToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    parseArgs(args) {
      return definition.parseArgs(args);
    },
    async call(api, args) {
      return await definition.call(api, args as Args);
    },
  };
}

const SESSION_MCP_DIRECT_TOOL_NAMES = new Set([
  "top_level_runs",
  "cell_descendants",
  "cell_ancestors",
  "cell_get",
  "ref_read",
  "session_recent",
  "ref_stat",
  "ref_write_to_file",
  "get_schema",
]);

const SESSION_MCP_TOOLS: SessionMcpToolDefinition[] = [
  defineTool({
    name: "procedure_list",
    description: "List nanoboss procedures that can be dispatched into the current master session.",
    inputSchema: {
      type: "object",
      properties: {
        includeHidden: { type: "boolean" },
      },
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        includeHidden: asOptionalBoolean(args.includeHidden),
      };
    },
    async call(api, args) {
      return await api.procedureList(args);
    },
  }),
  defineTool({
    name: "procedure_get",
    description: "Return metadata for one nanoboss procedure.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        name: asString(args.name, "name"),
      };
    },
    async call(api, args) {
      return await api.procedureGet(args);
    },
  }),
  defineTool({
    name: "procedure_dispatch_start",
    description: "Start a nanoboss procedure asynchronously on behalf of the current persistent master session and return a dispatch id quickly.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        defaultAgentSelection: {
          type: "object",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
          },
          required: ["provider"],
          additionalProperties: false,
        },
        dispatchCorrelationId: { type: "string" },
      },
      required: ["name", "prompt"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        name: asString(args.name, "name"),
        prompt: typeof args.prompt === "string" ? args.prompt : "",
        defaultAgentSelection: args.defaultAgentSelection === undefined
          ? undefined
          : parseDownstreamAgentSelection(args.defaultAgentSelection),
        dispatchCorrelationId: asOptionalString(args.dispatchCorrelationId),
      };
    },
    async call(api, args) {
      return await api.procedureDispatchStart(args);
    },
  }),
  defineTool({
    name: "procedure_dispatch_status",
    description: "Return the current durable status for an async nanoboss procedure dispatch.",
    inputSchema: {
      type: "object",
      properties: {
        dispatchId: { type: "string" },
      },
      required: ["dispatchId"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        dispatchId: asString(args.dispatchId, "dispatchId"),
      };
    },
    async call(api, args) {
      return await api.procedureDispatchStatus(args);
    },
  }),
  defineTool({
    name: "procedure_dispatch_wait",
    description: "Wait for a short bounded interval for an async nanoboss procedure dispatch, then return either the final result or the latest running status.",
    inputSchema: {
      type: "object",
      properties: {
        dispatchId: { type: "string" },
        waitMs: { type: "number" },
      },
      required: ["dispatchId"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        dispatchId: asString(args.dispatchId, "dispatchId"),
        waitMs: asOptionalNonNegativeNumber(args.waitMs, "waitMs"),
      };
    },
    async call(api, args) {
      return await api.procedureDispatchWait(args);
    },
  }),
  defineTool({
    name: "procedure_dispatch",
    description: "Compatibility wrapper that runs a nanoboss procedure on behalf of the current persistent master session and waits for the final result.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        defaultAgentSelection: {
          type: "object",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
          },
          required: ["provider"],
          additionalProperties: false,
        },
        dispatchCorrelationId: { type: "string" },
      },
      required: ["name", "prompt"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        name: asString(args.name, "name"),
        prompt: typeof args.prompt === "string" ? args.prompt : "",
        defaultAgentSelection: args.defaultAgentSelection === undefined
          ? undefined
          : parseDownstreamAgentSelection(args.defaultAgentSelection),
        dispatchCorrelationId: asOptionalString(args.dispatchCorrelationId),
      };
    },
    async call(api, args) {
      return await api.procedureDispatch(args);
    },
  }),
  defineTool({
    name: "top_level_runs",
    description: "Return top-level completed runs in reverse chronological order. Use this to find prior chat-visible commands such as /default, /linter, or /second-opinion.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        procedure: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        sessionId: asOptionalString(args.sessionId),
        procedure: asOptionalString(args.procedure),
        limit: asOptionalNonNegativeNumber(args.limit, "limit"),
      };
    },
    async call(api, args) {
      return api.topLevelRuns(args);
    },
  }),
  defineTool({
    name: "cell_descendants",
    description: "Return descendant cell summaries in depth-first pre-order. Use maxDepth: 1 when you only want direct children.",
    inputSchema: {
      type: "object",
      properties: {
        cellRef: CELL_REF_SCHEMA,
        kind: CELL_KIND_SCHEMA,
        procedure: { type: "string" },
        maxDepth: { type: "number" },
        limit: { type: "number" },
      },
      required: ["cellRef"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        cellRef: parseCellRef(args.cellRef),
        options: {
          kind: asOptionalCellKind(args.kind),
          procedure: asOptionalString(args.procedure),
          maxDepth: asOptionalNonNegativeNumber(args.maxDepth, "maxDepth"),
          limit: asOptionalNonNegativeNumber(args.limit, "limit"),
        },
      };
    },
    async call(api, args) {
      return api.cellDescendants(args.cellRef, args.options);
    },
  }),
  defineTool({
    name: "cell_ancestors",
    description: "Return ancestor cell summaries nearest-first. Set includeSelf to prepend the starting cell. Use limit: 1 when you only want the direct parent.",
    inputSchema: {
      type: "object",
      properties: {
        cellRef: CELL_REF_SCHEMA,
        includeSelf: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["cellRef"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        cellRef: parseCellRef(args.cellRef),
        options: {
          includeSelf: asOptionalBoolean(args.includeSelf),
          limit: asOptionalNonNegativeNumber(args.limit, "limit"),
        },
      };
    },
    async call(api, args) {
      return api.cellAncestors(args.cellRef, args.options);
    },
  }),
  defineTool({
    name: "cell_get",
    description: "Return one exact stored cell record.",
    inputSchema: {
      type: "object",
      properties: {
        cellRef: CELL_REF_SCHEMA,
      },
      required: ["cellRef"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        cellRef: parseCellRef(args.cellRef),
      };
    },
    async call(api, args) {
      return api.cellGet(args.cellRef);
    },
  }),
  defineTool({
    name: "ref_read",
    description: "Read the exact value at a durable session ref.",
    inputSchema: {
      type: "object",
      properties: {
        valueRef: VALUE_REF_SCHEMA,
      },
      required: ["valueRef"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        valueRef: parseValueRef(args.valueRef),
      };
    },
    async call(api, args) {
      return api.refRead(args.valueRef);
    },
  }),
  defineTool({
    name: "session_recent",
    description: "Return recent completed session cell summaries from the whole session. Use this only for global recency scans, not as the primary structural retrieval path.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        procedure: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        sessionId: asOptionalString(args.sessionId),
        procedure: asOptionalString(args.procedure),
        limit: asOptionalNonNegativeNumber(args.limit, "limit"),
      };
    },
    async call(api, args) {
      return api.sessionRecent(args);
    },
  }),
  defineTool({
    name: "ref_stat",
    description: "Return lightweight metadata for a durable session ref.",
    inputSchema: {
      type: "object",
      properties: {
        valueRef: VALUE_REF_SCHEMA,
      },
      required: ["valueRef"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        valueRef: parseValueRef(args.valueRef),
      };
    },
    async call(api, args) {
      return api.refStat(args.valueRef);
    },
  }),
  defineTool({
    name: "ref_write_to_file",
    description: "Write a durable session ref to a workspace file.",
    inputSchema: {
      type: "object",
      properties: {
        valueRef: VALUE_REF_SCHEMA,
        path: { type: "string" },
      },
      required: ["valueRef", "path"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        valueRef: parseValueRef(args.valueRef),
        path: asString(args.path, "path"),
      };
    },
    async call(api, args) {
      return api.refWriteToFile(args.valueRef, args.path);
    },
  }),
  defineTool({
    name: "get_schema",
    description: "Return compact shape metadata for a cell result or value ref.",
    inputSchema: {
      type: "object",
      properties: {
        cellRef: CELL_REF_SCHEMA,
        valueRef: VALUE_REF_SCHEMA,
      },
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        cellRef: args.cellRef !== undefined ? parseCellRef(args.cellRef) : undefined,
        valueRef: args.valueRef !== undefined ? parseValueRef(args.valueRef) : undefined,
      };
    },
    async call(api, args) {
      return api.getSchema(args);
    },
  }),
];

export function listSessionMcpTools(): JsonRpcToolMetadata[] {
  return SESSION_MCP_TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export async function callSessionMcpTool(
  api: SessionMcpApi,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = SESSION_MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return await tool.call(api, tool.parseArgs(args));
}

export async function dispatchSessionMcpMethod(
  api: SessionMcpApi,
  method: string,
  params: unknown,
): Promise<unknown> {
  return await dispatchMcpToolsMethod({
    api,
    method,
    messageParams: params,
    protocolVersion: SESSION_MCP_PROTOCOL_VERSION,
    serverName: SESSION_MCP_SERVER_NAME,
    serverVersion: getBuildLabel(),
    instructions: SESSION_MCP_INSTRUCTIONS,
    listTools: listSessionMcpTools,
    callTool: callSessionMcpTool,
    formatToolResult: formatSessionMcpToolResult,
  });
}

export function formatSessionMcpToolResult(
  toolName: string,
  result: unknown,
): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  return {
    content: [
      {
        type: "text",
        text: serializeToolResult(toolName, result),
      },
    ],
    structuredContent: toStructuredContentRecord(result),
  };
}

function toStructuredContentRecord(result: unknown): Record<string, unknown> {
  if (result === undefined) {
    return { value: null };
  }

  if (Array.isArray(result)) {
    return { items: result };
  }

  if (result && typeof result === "object") {
    return result as Record<string, unknown>;
  }

  return { value: result ?? null };
}

function serializeToolResult(toolName: string, result: unknown): string {
  if (toolName === "procedure_list") {
    const procedures = isProcedureListResult(result) ? result.procedures : [];
    return procedures.length > 0
      ? `Available procedures: ${procedures.map((procedure) => procedure.name).join(", ")}`
      : "No procedures available.";
  }

  if (toolName === "procedure_get" && isProcedureMetadata(result)) {
    return result.inputHint
      ? `${result.name}: ${result.description}\nInput hint: ${result.inputHint}`
      : `${result.name}: ${result.description}`;
  }

  if (toolName === "procedure_dispatch" && isProcedureDispatchResult(result)) {
    return serializeProcedureDispatchResult(result);
  }

  if (
    (toolName === "procedure_dispatch_start" ||
      toolName === "procedure_dispatch_status" ||
      toolName === "procedure_dispatch_wait") &&
    isProcedureDispatchStatusResult(result)
  ) {
    return serializeProcedureDispatchStatus(result);
  }

  if (toolName === "procedure_dispatch_start" && isProcedureDispatchStartResult(result)) {
    return `Dispatch queued: ${result.dispatchId}`;
  }

  if (typeof result === "string") {
    return result;
  }

  if (result === undefined) {
    return "null";
  }

  return JSON.stringify(result, null, 2);
}

async function loadSessionMcpRegistry(cwd: string): Promise<ProcedureRegistryLike> {
  const registry = new ProcedureRegistry({
    commandsDir: resolve(cwd, "commands"),
  });
  registry.loadBuiltins();
  if (shouldLoadDiskCommands()) {
    await registry.loadFromDisk();
  }
  return registry;
}

function getProcedureList(
  registry: ProcedureRegistryLike,
  includeHidden: boolean,
): SessionProcedureMetadata[] {
  const procedures = registry.toAvailableCommands()
    .filter((procedure) => !SESSION_MCP_DIRECT_TOOL_NAMES.has(procedure.name))
    .map((procedure) => ({
      name: procedure.name,
      description: procedure.description,
      inputHint: procedure.input?.hint,
    }));

  if (!includeHidden) {
    return procedures;
  }

  const defaultProcedure = registry.get("default");
  if (!defaultProcedure) {
    return procedures;
  }

  return [
    {
      name: defaultProcedure.name,
      description: defaultProcedure.description,
      inputHint: defaultProcedure.inputHint,
    },
    ...procedures,
  ];
}

function isProcedureListResult(value: unknown): value is ProcedureListResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { procedures?: unknown }).procedures)
  );
}

function isProcedureMetadata(value: unknown): value is SessionProcedureMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { description?: unknown }).description === "string"
  );
}

function isProcedureDispatchStartResult(value: unknown): value is ProcedureDispatchStartToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { dispatchId?: unknown }).dispatchId === "string" &&
    ((value as { status?: unknown }).status === "queued" ||
      (value as { status?: unknown }).status === "running" ||
      (value as { status?: unknown }).status === "completed")
  );
}

export function isProcedureDispatchStatusResult(value: unknown): value is ProcedureDispatchStatusToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { dispatchId?: unknown }).dispatchId === "string" &&
    typeof (value as { procedure?: unknown }).procedure === "string" &&
    typeof (value as { status?: unknown }).status === "string"
  );
}

export function isProcedureDispatchResult(value: unknown): value is ProcedureDispatchResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { procedure?: unknown }).procedure === "string" &&
    isCellRefLike((value as { cell?: unknown }).cell) &&
    typeof (value as { status?: unknown }).status !== "string" &&
    typeof (value as { dispatchId?: unknown }).dispatchId !== "string"
  );
}

function serializeProcedureDispatchResult(result: ProcedureDispatchResult): string {
  if (typeof result.display === "string" && result.display.trim()) {
    return result.display;
  }

  if (typeof result.summary === "string" && result.summary.trim()) {
    return result.summary;
  }

  return `${result.procedure} completed.`;
}

function serializeProcedureDispatchStatus(result: ProcedureDispatchStatusToolResult): string {
  if (result.status === "completed" && result.result) {
    return serializeProcedureDispatchResult(result.result);
  }

  if (result.status === "failed") {
    return result.error ? `Error: ${result.error}` : `Error: ${result.procedure} failed.`;
  }

  if (result.status === "cancelled") {
    return `${result.procedure} cancelled.`;
  }

  return `${result.procedure} ${result.status}. dispatchId=${result.dispatchId}`;
}

function isCellRefLike(value: unknown): value is CellRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    typeof (value as { cellId?: unknown }).cellId === "string"
  );
}

function parseCellRef(value: unknown): CellRef {
  const record = asObject(value);
  return {
    sessionId: asString(record.sessionId, "sessionId"),
    cellId: asString(record.cellId, "cellId"),
  };
}

function parseValueRef(value: unknown): ValueRef {
  const record = asObject(value);
  return {
    cell: parseCellRef(record.cell),
    path: asString(record.path, "path"),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object");
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${name} to be a non-empty string`);
  }

  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalCellKind(value: unknown): CellKind | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "top_level" || value === "procedure" || value === "agent") {
    return value;
  }

  throw new Error("Expected kind to be one of top_level, procedure, or agent");
}

function asOptionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Expected ${name} to be a non-negative number`);
  }

  return value;
}

function parseDownstreamAgentSelection(value: unknown): DownstreamAgentSelection {
  const record = asObject(value);
  const provider = asString(record.provider, "defaultAgentSelection.provider");
  if (provider !== "claude" && provider !== "gemini" && provider !== "codex" && provider !== "copilot") {
    throw new Error("Expected defaultAgentSelection.provider to be one of claude, gemini, codex, or copilot");
  }

  const model = record.model === undefined ? undefined : asString(record.model, "defaultAgentSelection.model");
  return {
    provider,
    model,
  };
}
