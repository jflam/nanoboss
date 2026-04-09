import { inferDataShape, stringifyCompactShape } from "./data-shape.ts";
import { createValueRef } from "../session/index.ts";
import type { SessionStore } from "../session/index.ts";
import type { CellRef, JsonValue, ValueRef } from "./types.ts";
import { summarizeText } from "../util/text.ts";

const DEFAULT_MAX_CARDS = 3;
const RECENT_SCAN_LIMIT = 200;

export interface ProcedureMemoryCard {
  cell: CellRef;
  procedure: string;
  input: string;
  summary?: string;
  memory?: string;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  dataShape?: JsonValue;
  dataPreview?: string;
  explicitDataSchema?: object;
  createdAt: string;
}

export function collectUnsyncedProcedureMemoryCards(
  store: SessionStore,
  syncedCellIds: ReadonlySet<string>,
  options: { maxCards?: number } = {},
): ProcedureMemoryCard[] {
  const maxCards = options.maxCards ?? DEFAULT_MAX_CARDS;
  const summaries = store.topLevelRuns({ limit: RECENT_SCAN_LIMIT });
  const unsynced: ProcedureMemoryCard[] = [];

  for (const summary of summaries) {
    if (syncedCellIds.has(summary.cell.cellId)) {
      continue;
    }

    const card = materializeProcedureMemoryCard(store, summary.cell, summary.dataShape);
    if (!card) {
      continue;
    }

    unsynced.push(card);

    if (unsynced.length >= maxCards) {
      break;
    }
  }

  return unsynced.reverse();
}

export function materializeProcedureMemoryCard(
  store: SessionStore,
  cell: CellRef,
  dataShape?: JsonValue,
): ProcedureMemoryCard | undefined {
  const record = store.readCell(cell);
  if (record.procedure === "default") {
    return undefined;
  }

  const memory = deriveProcedureMemory(record.output.memory, record.output.summary, record.output.display);
  const dataRef = record.output.data !== undefined
    ? createValueRef(cell, "output.data")
    : undefined;
  const displayRef = record.output.display !== undefined
    ? createValueRef(cell, "output.display")
    : undefined;

  return {
    cell,
    procedure: record.procedure,
    input: record.input,
    summary: record.output.summary,
    memory,
    dataRef,
    displayRef,
    dataShape: dataShape ?? (record.output.data !== undefined ? inferDataShape(record.output.data) : undefined),
    dataPreview: buildDataPreview(record.output.data),
    explicitDataSchema: record.output.explicitDataSchema,
    createdAt: record.meta.createdAt,
  };
}

export function renderProcedureMemoryCardsSection(cards: ProcedureMemoryCard[]): string | undefined {
  if (cards.length === 0) {
    return undefined;
  }

  const lines = [
    "Nanoboss session memory update:",
    "",
  ];

  for (const card of cards) {
    lines.push(...renderProcedureMemoryCardLines(card), "");
  }

  return lines.join("\n").trimEnd();
}

export function renderProcedureMemoryCardLines(card: ProcedureMemoryCard): string[] {
  const lines = [
    `- procedure: /${card.procedure}`,
    `- input: ${summarizeText(card.input, 140)}`,
  ];

  if (card.summary) {
    lines.push(`- summary: ${summarizeText(card.summary, 220)}`);
  }

  if (card.memory) {
    lines.push(`- memory: ${summarizeText(card.memory, 280)}`);
  }

  if (card.dataRef) {
    lines.push(`- result_ref: ${formatValueRef(card.dataRef)}`);
  }

  if (card.displayRef) {
    lines.push(`- display_ref: ${formatValueRef(card.displayRef)}`);
  }

  if (card.dataPreview) {
    lines.push(`- data_preview: ${card.dataPreview}`);
  }

  const shape = stringifyCompactShape(card.dataShape, 220);
  if (shape) {
    lines.push(`- data_shape: ${shape}`);
  }

  if (card.explicitDataSchema) {
    const schema = summarizeText(JSON.stringify(card.explicitDataSchema), 220);
    lines.push(`- explicit_data_schema: ${schema}`);
  }

  return lines;
}

export function hasTopLevelNonDefaultProcedureHistory(store: SessionStore): boolean {
  return store.topLevelRuns({ limit: RECENT_SCAN_LIMIT }).some((summary) => {
    const record = store.readCell(summary.cell);
    return record.procedure !== "default";
  });
}

function deriveProcedureMemory(
  memory: string | undefined,
  summary: string | undefined,
  display: string | undefined,
): string | undefined {
  if (memory && memory.trim()) {
    return memory.trim();
  }

  if (summary && summary.trim()) {
    return summary.trim();
  }

  if (display && display.trim()) {
    return summarizeText(display, 220);
  }

  return undefined;
}

function buildDataPreview(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const entries = Object.entries(data)
    .filter(([, value]) => value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    .slice(0, 6)
    .map(([key, value]) => [key, typeof value === "string" ? summarizeText(value, 80) : value] as const);

  if (entries.length === 0) {
    return undefined;
  }

  return summarizeText(JSON.stringify(Object.fromEntries(entries)), 220);
}

function formatValueRef(valueRef: ValueRef): string {
  return [
    `session=${valueRef.cell.sessionId}`,
    `cell=${valueRef.cell.cellId}`,
    `path=${valueRef.path}`,
  ].join(" ");
}
