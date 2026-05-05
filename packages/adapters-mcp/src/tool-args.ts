import type { ListRunsArgs } from "@nanoboss/app-runtime";
import type {
  Ref,
  RunKind,
  RunRef,
} from "@nanoboss/contracts";

export const RUN_REF_SCHEMA = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    runId: { type: "string" },
  },
  required: ["sessionId", "runId"],
  additionalProperties: false,
};

export const REF_SCHEMA = {
  type: "object",
  properties: {
    run: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        runId: { type: "string" },
      },
      required: ["sessionId", "runId"],
      additionalProperties: false,
    },
    path: { type: "string" },
  },
  required: ["run", "path"],
  additionalProperties: false,
};

export const CELL_KIND_SCHEMA = {
  type: "string",
  enum: ["top_level", "procedure", "agent"],
};

export function parseRunRef(value: unknown): RunRef {
  const record = asObject(value);
  return {
    sessionId: asString(record.sessionId, "sessionId"),
    runId: asString(record.runId, "runId"),
  };
}

export function parseRef(value: unknown): Ref {
  const record = asObject(value);
  return {
    run: parseRunRef(record.run),
    path: asString(record.path, "path"),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object");
  }

  return value as Record<string, unknown>;
}

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${name} to be a non-empty string`);
  }

  return value;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asOptionalRunKind(value: unknown): RunKind | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "top_level" || value === "procedure" || value === "agent") {
    return value;
  }

  throw new Error("Expected kind to be one of top_level, procedure, or agent");
}

export function asOptionalRunScope(value: unknown): ListRunsArgs["scope"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "recent" || value === "top_level") {
    return value;
  }

  throw new Error("Expected scope to be 'recent' or 'top_level'");
}

export function asOptionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Expected ${name} to be a non-negative number`);
  }

  return value;
}
