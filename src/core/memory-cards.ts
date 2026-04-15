import { inferDataShape, stringifyCompactShape } from "./data-shape.ts";
import type { SessionStore } from "@nanoboss/store";
import type { JsonValue, Ref, RunRef } from "./types.ts";
import { createRef } from "./types.ts";
import { summarizeText } from "../util/text.ts";

const DEFAULT_MAX_CARDS = 3;
const RECENT_SCAN_LIMIT = 200;

export interface ProcedureMemoryCard {
  run: RunRef;
  procedure: string;
  input: string;
  summary?: string;
  memory?: string;
  dataRef?: Ref;
  displayRef?: Ref;
  dataShape?: JsonValue;
  dataPreview?: string;
  explicitDataSchema?: object;
  createdAt: string;
}

export function collectUnsyncedProcedureMemoryCards(
  store: SessionStore,
  syncedRunIds: ReadonlySet<string>,
  options: { maxCards?: number } = {},
): ProcedureMemoryCard[] {
  const maxCards = options.maxCards ?? DEFAULT_MAX_CARDS;
  const summaries = store.listRuns({ limit: RECENT_SCAN_LIMIT });
  const unsynced: ProcedureMemoryCard[] = [];

  for (const summary of summaries) {
    if (syncedRunIds.has(summary.run.runId)) {
      continue;
    }

    const card = materializeProcedureMemoryCard(
      store,
      summary.run,
      summary.dataShape,
    );
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
  run: RunRef,
  dataShape?: JsonValue,
): ProcedureMemoryCard | undefined {
  const record = store.getRun(run);
  if (record.procedure === "default") {
    return undefined;
  }

  const memory = deriveProcedureMemory(record.output.memory, record.output.summary, record.output.display);
  const dataRef = record.output.data !== undefined
    ? createRef(run, "output.data")
    : undefined;
  const displayRef = record.output.display !== undefined
    ? createRef(run, "output.display")
    : undefined;

  return {
    run,
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
    lines.push(`- result_ref: ${formatRef(card.dataRef)}`);
  }

  if (card.displayRef) {
    lines.push(`- display_ref: ${formatRef(card.displayRef)}`);
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
  return store.listRuns({ limit: RECENT_SCAN_LIMIT }).some((summary) => {
    const record = store.getRun(summary.run);
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

function formatRef(ref: Ref): string {
  return [
    `session=${ref.run.sessionId}`,
    `run=${ref.run.runId}`,
    `path=${ref.path}`,
  ].join(" ");
}
