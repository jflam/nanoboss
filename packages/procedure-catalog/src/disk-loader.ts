import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  discoverDiskModules,
  getDiskModuleDefaultExport,
  loadDiskModule,
} from "@nanoboss/app-support";
import type {
  Procedure,
  ProcedureExecutionMode,
  ProcedureMetadata,
} from "@nanoboss/procedure-sdk";
import { resolveProcedureEntryRelativePath } from "./names.ts";

interface DiskProcedureDefinition extends ProcedureMetadata {
  continuation?: {
    supportsResume: true;
  };
  path: string;
}

interface LoadableProcedureMetadata extends ProcedureMetadata {
  continuation?: {
    supportsResume: true;
  };
}

const PROCEDURE_CACHE_NAMESPACE = "procedure-builds";
const PROCEDURE_ENTRY_DIR_HINTS = ["procedures"] as const;

export function discoverDiskProcedures(procedureRoot: string): DiskProcedureDefinition[] {
  return discoverDiskModules<LoadableProcedureMetadata>({
    root: procedureRoot,
    readMetadata: ({ path, source }) => readProcedureMetadata(path, source),
  }).map(({ path, metadata }) => ({ ...metadata, path }));
}

export async function loadProcedureFromPath(path: string): Promise<Procedure> {
  const loaded = await loadDiskModule({
    path,
    cacheNamespace: PROCEDURE_CACHE_NAMESPACE,
    entryDirHints: PROCEDURE_ENTRY_DIR_HINTS,
  });
  const procedure = getDiskModuleDefaultExport(loaded);
  assertProcedure(procedure);
  return procedure;
}

export function persistProcedureSource(params: {
  procedureName: string;
  source: string;
  procedureRoot: string;
}): string {
  const filePath = join(resolve(params.procedureRoot), resolveProcedureEntryRelativePath(params.procedureName));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, params.source, "utf8");
  return filePath;
}

function assertProcedure(procedure: unknown): asserts procedure is Procedure {
  if (
    !procedure ||
    typeof procedure !== "object" ||
    typeof (procedure as Procedure).name !== "string" ||
    typeof (procedure as Procedure).description !== "string" ||
    typeof (procedure as Procedure).execute !== "function"
  ) {
    throw new Error("Procedure module does not export a valid default procedure");
  }
}

function readProcedureMetadata(path: string, source: string): LoadableProcedureMetadata | undefined {
  if (!looksLikeProcedureModule(source)) {
    return undefined;
  }

  return {
    name: readStaticStringProperty(source, "name") ?? basename(path, ".ts"),
    description: readStaticStringProperty(source, "description") ?? `Lazy-loaded procedure from ${basename(path)}`,
    inputHint: readStaticStringProperty(source, "inputHint"),
    executionMode: parseExecutionMode(readStaticStringProperty(source, "executionMode")),
    continuation: looksLikeResumableProcedureModule(source)
      ? { supportsResume: true }
      : undefined,
  };
}

function looksLikeProcedureModule(source: string): boolean {
  return /\bexport\s+default\b/u.test(source)
    && (/\b(?:async\s+)?execute\s*\(/u.test(source) || /\bexecute\s*:/u.test(source));
}

function looksLikeResumableProcedureModule(source: string): boolean {
  return /\b(?:async\s+)?resume\s*\(/u.test(source) || /\bresume\s*:/u.test(source);
}

function parseExecutionMode(value: string | undefined): ProcedureExecutionMode | undefined {
  if (value === "agentSession" || value === "harness") {
    return value;
  }

  return undefined;
}

function readStaticStringProperty(source: string, propertyName: string): string | undefined {
  const patterns = [
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u"),
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`, "u"),
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*` + "`((?:\\\\.|[^`\\\\])*)`", "u"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.[1] !== undefined) {
      return decodeStringLiteral(match[1]);
    }
  }

  return undefined;
}

function decodeStringLiteral(value: string): string {
  return value.replace(/\\([\\'"`nrt])/g, (_, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
