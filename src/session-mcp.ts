import { getBuildLabel } from "./build-info.ts";
import { inferDataShape } from "./data-shape.ts";
import { SessionStore } from "./session-store.ts";
import type {
  CellDescendantsOptions,
  CellFilterOptions,
  CellKind,
  CellRecord,
  CellRef,
  ValueRef,
} from "./types.ts";

export const SESSION_MCP_PROTOCOL_VERSION = "2025-11-25";
export const SESSION_MCP_SERVER_NAME = "nanoboss-session";
export const SESSION_MCP_INSTRUCTIONS = "Use these tools to inspect durable nanoboss session cells and refs.";

interface SessionMcpParams {
  sessionId: string;
  cwd: string;
  rootDir?: string;
}

interface SessionMcpToolMetadata {
  name: string;
  description: string;
  inputSchema: object;
}

interface SessionMcpToolDefinition extends SessionMcpToolMetadata {
  parseArgs(args: Record<string, unknown>): unknown;
  call(api: SessionMcpApi, args: unknown): unknown;
}

export interface SessionSchemaResult {
  target: CellRef | ValueRef;
  dataShape: unknown;
  explicitDataSchema?: object;
}

export class SessionMcpApi {
  constructor(private readonly params: SessionMcpParams) {}

  sessionRecent(args: { procedure?: string; limit?: number } = {}): ReturnType<SessionStore["recent"]> {
    return this.createStore().recent(args);
  }

  topLevelRuns(args: Omit<CellFilterOptions, "kind"> = {}): ReturnType<SessionStore["topLevelRuns"]> {
    return this.createStore().topLevelRuns(args);
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

  private createStore(): SessionStore {
    return new SessionStore({
      sessionId: this.params.sessionId,
      cwd: this.params.cwd,
      rootDir: this.params.rootDir,
    });
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
  call(api: SessionMcpApi, args: Args): unknown;
}): SessionMcpToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    parseArgs(args) {
      return definition.parseArgs(args);
    },
    call(api, args) {
      return definition.call(api, args as Args);
    },
  };
}

const SESSION_MCP_TOOLS: SessionMcpToolDefinition[] = [
  defineTool({
    name: "top_level_runs",
    description: "Return top-level completed runs in reverse chronological order. Use this to find prior chat-visible commands such as /default, /linter, or /second-opinion.",
    inputSchema: {
      type: "object",
      properties: {
        procedure: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        procedure: asOptionalString(args.procedure),
        limit: asOptionalNonNegativeNumber(args.limit, "limit"),
      };
    },
    call(api, args) {
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
    call(api, args) {
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
    call(api, args) {
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
    call(api, args) {
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
    call(api, args) {
      return api.refRead(args.valueRef);
    },
  }),
  defineTool({
    name: "session_recent",
    description: "Return recent completed session cell summaries from the whole session. Use this only for global recency scans, not as the primary structural retrieval path.",
    inputSchema: {
      type: "object",
      properties: {
        procedure: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        procedure: asOptionalString(args.procedure),
        limit: asOptionalNonNegativeNumber(args.limit, "limit"),
      };
    },
    call(api, args) {
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
    call(api, args) {
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
    call(api, args) {
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
    call(api, args) {
      return api.getSchema(args);
    },
  }),
];

export function listSessionMcpTools(): SessionMcpToolMetadata[] {
  return SESSION_MCP_TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export function callSessionMcpTool(api: SessionMcpApi, name: string, args: Record<string, unknown>): unknown {
  const tool = SESSION_MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return tool.call(api, tool.parseArgs(args));
}

export function dispatchSessionMcpMethod(
  api: SessionMcpApi,
  method: string,
  params: unknown,
): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: SESSION_MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SESSION_MCP_SERVER_NAME,
          version: getBuildLabel(),
        },
        instructions: SESSION_MCP_INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: listSessionMcpTools(),
      };
    case "tools/call": {
      const args = asObject(params);
      const name = asString(args.name, "name");
      const toolArgs = asOptionalObject(args.arguments);
      return formatSessionMcpToolResult(callSessionMcpTool(api, name, toolArgs));
    }
    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

export function formatSessionMcpToolResult(result: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent: unknown } {
  return {
    content: [
      {
        type: "text",
        text: serializeToolResult(result),
      },
    ],
    structuredContent: result,
  };
}

function serializeToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (result === undefined) {
    return "null";
  }

  return JSON.stringify(result, null, 2);
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

function asOptionalObject(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  return asObject(value);
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
