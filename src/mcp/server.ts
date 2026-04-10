
import { getBuildLabel } from "../core/build-info.ts";
import { inferDataShape } from "../core/data-shape.ts";
import { parseRequiredDownstreamAgentSelection } from "../core/downstream-agent-selection.ts";
import { dispatchMcpToolsMethod, type JsonRpcToolMetadata } from "./jsonrpc.ts";
import { runStdioJsonRpcServer } from "./stdio-jsonrpc.ts";
import {
  ProcedureDispatchJobManager,
  type ProcedureDispatchStartResult,
  type ProcedureDispatchStatusResult,
} from "../procedure/dispatch-jobs.ts";
import { type ProcedureExecutionResult } from "../procedure/runner.ts";
import { ProcedureRegistry, projectProcedureMetadata } from "../procedure/registry.ts";
import { SessionStore, readCurrentSessionMetadata, readSessionMetadata } from "../session/index.ts";
import { shouldLoadDiskCommands } from "../core/runtime-mode.ts";
import type {
  CellDescendantsOptions,
  CellKind,
  CellRecord,
  CellRef,
  DownstreamAgentSelection,
  ProcedureMetadata,
  ProcedureRegistryLike,
  SessionRecentOptions,
  TopLevelRunsOptions,
  ValueRef,
} from "../core/types.ts";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SERVER_NAME = "nanoboss";
export const MCP_INSTRUCTIONS = "Use these tools to dispatch nanoboss procedures and inspect durable session state. Prefer an explicit sessionId for session-scoped operations such as procedure_dispatch_start, top_level_runs, and session_recent. If sessionId is omitted, the current session for the server working directory may be used when available.";

export interface McpServerOptions {
  instructions?: string;
  protocolVersion?: string;
  serverName?: string;
}

interface McpApiParams {
  sessionId?: string;
  cwd: string;
  rootDir?: string;
  registry?: ProcedureRegistryLike;
  allowCurrentSessionFallback?: boolean;
}

interface McpToolDefinition extends JsonRpcToolMetadata {
  parseArgs(args: Record<string, unknown>): unknown;
  call(api: NanobossMcpApi, args: unknown): Promise<unknown>;
}

interface ProcedureListResult {
  procedures: ProcedureMetadata[];
}

export type ProcedureDispatchResult = ProcedureExecutionResult;
export type ProcedureDispatchStartToolResult = ProcedureDispatchStartResult;
export type ProcedureDispatchStatusToolResult = ProcedureDispatchStatusResult;

export interface McpSchemaResult {
  target: CellRef | ValueRef;
  dataShape: unknown;
  explicitDataSchema?: object;
}

export class NanobossMcpApi {
  constructor(private readonly params: McpApiParams) {}

  sessionRecent(args: SessionRecentOptions & { sessionId?: string } = {}): ReturnType<SessionStore["recent"]> {
    return this.createStore(args.sessionId).recent(args);
  }

  topLevelRuns(args: TopLevelRunsOptions & { sessionId?: string } = {}): ReturnType<SessionStore["topLevelRuns"]> {
    return this.createStore(args.sessionId).topLevelRuns(args);
  }

  cellGet(cellRef: CellRef): CellRecord {
    return this.createStoreForCellRef(cellRef).readCell(cellRef);
  }

  cellAncestors(
    cellRef: CellRef,
    args: { includeSelf?: boolean; limit?: number } = {},
  ): ReturnType<SessionStore["ancestors"]> {
    return this.createStoreForCellRef(cellRef).ancestors(cellRef, args);
  }

  cellDescendants(
    cellRef: CellRef,
    args: CellDescendantsOptions = {},
  ): ReturnType<SessionStore["descendants"]> {
    return this.createStoreForCellRef(cellRef).descendants(cellRef, args);
  }

  refRead(valueRef: ValueRef): unknown {
    return this.createStoreForValueRef(valueRef).readRef(valueRef);
  }

  refStat(valueRef: ValueRef) {
    return this.createStoreForValueRef(valueRef).statRef(valueRef);
  }

  refWriteToFile(valueRef: ValueRef, path: string): { path: string } {
    const store = this.createStoreForValueRef(valueRef);
    store.writeRefToFile(valueRef, path, store.cwd);
    return { path };
  }

  getSchema(args: { cellRef?: CellRef; valueRef?: ValueRef }): McpSchemaResult {
    if (args.valueRef) {
      const store = this.createStoreForValueRef(args.valueRef);
      const value = store.readRef(args.valueRef);
      return {
        target: args.valueRef,
        dataShape: inferDataShape(value),
      };
    }

    if (!args.cellRef) {
      throw new Error("get_schema requires cellRef or valueRef");
    }

    const store = this.createStoreForCellRef(args.cellRef);
    const cell = store.readCell(args.cellRef);
    return {
      target: args.cellRef,
      dataShape: inferDataShape(cell.output.data),
      explicitDataSchema: cell.output.explicitDataSchema,
    };
  }

  async procedureList(args: { includeHidden?: boolean; sessionId?: string } = {}): Promise<ProcedureListResult> {
    const registry = await this.getRegistry(args.sessionId);
    return {
      procedures: getProcedureList(registry, args.includeHidden === true),
    };
  }

  async procedureGet(args: { name: string; sessionId?: string }): Promise<ProcedureMetadata> {
    const registry = await this.getRegistry(args.sessionId);
    const procedure = registry.listMetadata().find((candidate) => candidate.name === args.name);
    if (!procedure) {
      throw new Error(`Unknown procedure: ${args.name}`);
    }

    return toPublicProcedureMetadata(procedure);
  }

  async procedureDispatchStart(args: {
    sessionId?: string;
    name: string;
    prompt: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    dispatchCorrelationId?: string;
  }): Promise<ProcedureDispatchStartToolResult> {
    return await this.createDispatchJobManager(args.sessionId).start({
      name: args.name,
      prompt: args.prompt,
      defaultAgentSelection: args.defaultAgentSelection,
      dispatchCorrelationId: args.dispatchCorrelationId,
    });
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

  private createStore(sessionIdOverride?: string): SessionStore {
    const context = this.resolveEffectiveContext(sessionIdOverride);
    if (!context.sessionId) {
      throw new Error("Nanoboss MCP requires an explicit sessionId or a current session for the server working directory.");
    }

    return new SessionStore({
      sessionId: context.sessionId,
      cwd: context.cwd,
      rootDir: context.rootDir,
    });
  }

  private createStoreForCellRef(cellRef: CellRef): SessionStore {
    return this.createStore(cellRef.sessionId);
  }

  private createStoreForValueRef(valueRef: ValueRef): SessionStore {
    return this.createStore(valueRef.cell.sessionId);
  }

  private createDispatchJobManager(sessionIdOverride?: string): ProcedureDispatchJobManager {
    const context = this.resolveEffectiveContext(sessionIdOverride);
    const store = this.createStore(sessionIdOverride);
    return new ProcedureDispatchJobManager({
      cwd: context.cwd,
      sessionId: store.sessionId,
      rootDir: store.rootDir,
      getRegistry: async () => await this.getRegistry(store.sessionId),
    });
  }

  private async getRegistry(sessionIdOverride?: string): Promise<ProcedureRegistryLike> {
    if (this.params.registry) {
      return this.params.registry;
    }

    return await loadMcpRegistry(this.resolveEffectiveContext(sessionIdOverride).cwd);
  }

  private resolveEffectiveContext(sessionIdOverride?: string): { sessionId?: string; cwd: string; rootDir?: string } {
    const explicitSessionId = sessionIdOverride ?? this.params.sessionId;
    if (explicitSessionId) {
      const metadata = readSessionMetadata(explicitSessionId);
      if (metadata) {
        return {
          sessionId: metadata.sessionId,
          cwd: metadata.cwd,
          rootDir: metadata.rootDir,
        };
      }

      return {
        sessionId: explicitSessionId,
        cwd: this.params.cwd,
        rootDir: this.params.rootDir,
      };
    }

    if (this.params.allowCurrentSessionFallback) {
      const current = readCurrentSessionMetadata(this.params.cwd);
      if (current) {
        return {
          sessionId: current.sessionId,
          cwd: current.cwd,
          rootDir: current.rootDir,
        };
      }
    }

    return {
      cwd: this.params.cwd,
      rootDir: this.params.rootDir,
    };
  }
}

export function createNanobossMcpApi(params: McpApiParams): NanobossMcpApi {
  return new NanobossMcpApi(params);
}

export function createCurrentSessionBackedNanobossMcpApi(cwd = process.cwd()): NanobossMcpApi {
  return createNanobossMcpApi({
    cwd,
    allowCurrentSessionFallback: true,
  });
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
  call(api: NanobossMcpApi, args: Args): Promise<unknown>;
}): McpToolDefinition {
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

const MCP_TOOLS: McpToolDefinition[] = [
  defineTool({
    name: "procedure_list",
    description: "List nanoboss procedures that can be dispatched for the targeted session workspace.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        includeHidden: { type: "boolean" },
      },
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        sessionId: asOptionalString(args.sessionId),
        includeHidden: asOptionalBoolean(args.includeHidden),
      };
    },
    async call(api, args) {
      return await api.procedureList(args);
    },
  }),
  defineTool({
    name: "procedure_get",
    description: "Return metadata for one nanoboss procedure in the targeted session workspace.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        sessionId: asOptionalString(args.sessionId),
        name: asString(args.name, "name"),
      };
    },
    async call(api, args) {
      return await api.procedureGet(args);
    },
  }),
  defineTool({
    name: "procedure_dispatch_start",
    description: "Start an async nanoboss slash-command dispatch for the targeted session. Returns quickly with a dispatch id; then call procedure_dispatch_wait until the dispatch reaches a terminal status.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
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
        sessionId: asOptionalString(args.sessionId),
        name: asString(args.name, "name"),
        prompt: typeof args.prompt === "string" ? args.prompt : "",
        defaultAgentSelection: args.defaultAgentSelection === undefined
          ? undefined
          : parseRequiredDownstreamAgentSelection(args.defaultAgentSelection),
        dispatchCorrelationId: asOptionalString(args.dispatchCorrelationId),
      };
    },
    async call(api, args) {
      return await api.procedureDispatchStart(args);
    },
  }),
  defineTool({
    name: "procedure_dispatch_status",
    description: "Optional non-blocking status check for an async nanoboss procedure dispatch. If you are already in the normal start/wait flow, prefer procedure_dispatch_wait.",
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
    description: "Wait briefly for a started nanoboss async dispatch, then return either the latest running status or the final result.",
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
    description: "Return recent completed session cell summaries from the whole targeted session. Use this only for global recency scans, not as the primary structural retrieval path.",
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

export function listMcpTools(): JsonRpcToolMetadata[] {
  return MCP_TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export async function callMcpTool(
  api: NanobossMcpApi,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return await tool.call(api, tool.parseArgs(args));
}

export async function dispatchMcpMethod(
  api: NanobossMcpApi,
  method: string,
  params: unknown,
  options: McpServerOptions = {},
): Promise<unknown> {
  return await dispatchMcpToolsMethod({
    api,
    method,
    messageParams: params,
    protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION,
    serverName: options.serverName ?? MCP_SERVER_NAME,
    serverVersion: getBuildLabel(),
    instructions: options.instructions ?? MCP_INSTRUCTIONS,
    listTools: listMcpTools,
    callTool: callMcpTool,
    formatToolResult: formatMcpToolResult,
  });
}

export async function runMcpServer(
  api: NanobossMcpApi,
  options: McpServerOptions = {},
): Promise<void> {
  await runStdioJsonRpcServer((method, messageParams) => dispatchMcpMethod(api, method, messageParams, options));
}

export function formatMcpToolResult(
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

  if (
    (toolName === "procedure_dispatch_start" ||
      toolName === "procedure_dispatch_status" ||
      toolName === "procedure_dispatch_wait") &&
    isProcedureDispatchStatusResult(result)
  ) {
    return serializeProcedureDispatchStatus(result);
  }

  if (toolName === "procedure_dispatch_start" && isProcedureDispatchStartResult(result)) {
    return `Dispatch started. dispatchId=${result.dispatchId}. Next call procedure_dispatch_wait with this same dispatch id.`;
  }

  if (typeof result === "string") {
    return result;
  }

  if (result === undefined) {
    return "null";
  }

  return JSON.stringify(result, null, 2);
}

async function loadMcpRegistry(cwd: string): Promise<ProcedureRegistryLike> {
  const registry = new ProcedureRegistry({
    workspaceDir: cwd,
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
): ProcedureMetadata[] {
  return projectProcedureMetadata(registry.listMetadata(), { includeHidden })
    .map(toPublicProcedureMetadata);
}

function toPublicProcedureMetadata(metadata: ProcedureMetadata): ProcedureMetadata {
  return {
    name: metadata.name,
    description: metadata.description,
    inputHint: metadata.inputHint,
  };
}

function isProcedureListResult(value: unknown): value is ProcedureListResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { procedures?: unknown }).procedures)
  );
}

function isProcedureMetadata(value: unknown): value is ProcedureMetadata {
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

  return `${result.procedure} ${result.status}. dispatchId=${result.dispatchId}. Call procedure_dispatch_wait again with this same dispatch id.`;
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
