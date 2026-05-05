import type { RuntimeService } from "@nanoboss/app-runtime";
import { parseRequiredDownstreamAgentSelection } from "@nanoboss/store";

import type { JsonRpcToolMetadata } from "./jsonrpc.ts";
import {
  CELL_KIND_SCHEMA,
  REF_SCHEMA,
  RUN_REF_SCHEMA,
  asOptionalBoolean,
  asOptionalNonNegativeNumber,
  asOptionalRunKind,
  asOptionalRunScope,
  asOptionalString,
  asString,
  parseRef,
  parseRunRef,
} from "./tool-args.ts";

interface McpToolDefinition extends JsonRpcToolMetadata {
  parseArgs(args: Record<string, unknown>): unknown;
  call(runtime: RuntimeService, args: unknown): Promise<unknown>;
}

function defineTool<Args>(definition: {
  name: string;
  description: string;
  inputSchema: object;
  parseArgs(args: Record<string, unknown>): Args;
  call(runtime: RuntimeService, args: Args): Promise<unknown>;
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

export const MCP_TOOLS: McpToolDefinition[] = [
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
        prompt: asString(args.prompt, "prompt"),
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
    name: "list_runs",
    description: "List stored runs for the targeted session. Defaults to top-level runs; use scope='recent' only for true global recency scans.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        procedure: { type: "string" },
        limit: { type: "number" },
        scope: {
          type: "string",
          enum: ["recent", "top_level"],
        },
      },
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        sessionId: asOptionalString(args.sessionId),
        procedure: asOptionalString(args.procedure),
        limit: asOptionalNonNegativeNumber(args.limit, "limit"),
        scope: asOptionalRunScope(args.scope),
      };
    },
    async call(api, args) {
      return api.listRuns(args);
    },
  }),
  defineTool({
    name: "get_run_descendants",
    description: "Return descendant run summaries in depth-first pre-order. Use maxDepth: 1 when you only want direct children.",
    inputSchema: {
      type: "object",
      properties: {
        runRef: RUN_REF_SCHEMA,
        kind: CELL_KIND_SCHEMA,
        procedure: { type: "string" },
        maxDepth: { type: "number" },
        limit: { type: "number" },
      },
      required: ["runRef"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        runRef: parseRunRef(args.runRef),
        options: {
          kind: asOptionalRunKind(args.kind),
          procedure: asOptionalString(args.procedure),
          maxDepth: asOptionalNonNegativeNumber(args.maxDepth, "maxDepth"),
          limit: asOptionalNonNegativeNumber(args.limit, "limit"),
        },
      };
    },
    async call(api, args) {
      return api.getRunDescendants(args.runRef, args.options);
    },
  }),
  defineTool({
    name: "get_run_ancestors",
    description: "Return ancestor run summaries nearest-first. Set includeSelf to prepend the starting run. Use limit: 1 when you only want the direct parent.",
    inputSchema: {
      type: "object",
      properties: {
        runRef: RUN_REF_SCHEMA,
        includeSelf: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["runRef"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        runRef: parseRunRef(args.runRef),
        options: {
          includeSelf: asOptionalBoolean(args.includeSelf),
          limit: asOptionalNonNegativeNumber(args.limit, "limit"),
        },
      };
    },
    async call(api, args) {
      return api.getRunAncestors(args.runRef, args.options);
    },
  }),
  defineTool({
    name: "get_run",
    description: "Return one exact stored run record.",
    inputSchema: {
      type: "object",
      properties: {
        runRef: RUN_REF_SCHEMA,
      },
      required: ["runRef"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        runRef: parseRunRef(args.runRef),
      };
    },
    async call(api, args) {
      return api.getRun(args.runRef);
    },
  }),
  defineTool({
    name: "read_ref",
    description: "Read the exact value at a durable session ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF_SCHEMA,
      },
      required: ["ref"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        ref: parseRef(args.ref),
      };
    },
    async call(api, args) {
      return api.readRef(args.ref);
    },
  }),
  defineTool({
    name: "stat_ref",
    description: "Return lightweight metadata for a durable session ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF_SCHEMA,
      },
      required: ["ref"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        ref: parseRef(args.ref),
      };
    },
    async call(api, args) {
      return api.statRef(args.ref);
    },
  }),
  defineTool({
    name: "ref_write_to_file",
    description: "Write a durable session ref to a workspace file.",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF_SCHEMA,
        path: { type: "string" },
      },
      required: ["ref", "path"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        ref: parseRef(args.ref),
        path: asString(args.path, "path"),
      };
    },
    async call(api, args) {
      return api.refWriteToFile(args.ref, args.path);
    },
  }),
  defineTool({
    name: "get_ref_schema",
    description: "Return compact shape metadata for a durable value ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF_SCHEMA,
      },
      required: ["ref"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        ref: parseRef(args.ref),
      };
    },
    async call(api, args) {
      return api.getRefSchema(args.ref);
    },
  }),
  defineTool({
    name: "get_run_schema",
    description: "Return compact shape metadata for a stored run result.",
    inputSchema: {
      type: "object",
      properties: {
        runRef: RUN_REF_SCHEMA,
      },
      required: ["runRef"],
      additionalProperties: false,
    },
    parseArgs(args) {
      return {
        runRef: parseRunRef(args.runRef),
      };
    },
    async call(api, args) {
      return api.getRunSchema(args.runRef);
    },
  }),
];
