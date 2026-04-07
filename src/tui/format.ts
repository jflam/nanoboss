import { getAgentTokenUsagePercent } from "../agent/token-usage.ts";
import type { AgentTokenUsage, ValueRef } from "../core/types.ts";
import { summarizeText } from "../util/text.ts";

export function isWrapperToolTitle(title: string): boolean {
  return (
    title.startsWith("callAgent") ||
    title.startsWith("defaultSession:") ||
    title.startsWith("Calling default procedure") ||
    title.includes("procedure_dispatch")
  );
}

export function shouldRemoveCompletedWrapperCard(title: string): boolean {
  return title.startsWith("callAgent") || title.startsWith("defaultSession:") || title.includes("procedure_dispatch");
}

export function shouldSuppressToolTraceTitle(title: string): boolean {
  return title.includes("procedure_dispatch_wait");
}

export function formatToolTraceLine(depth: number, text: string): string {
  return `${"│ ".repeat(depth)}${text}`;
}

export function formatMemoryCardsLines(cards: Array<{
  procedure: string;
  input: string;
  summary?: string;
  memory?: string;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  dataPreview?: string;
  dataShape?: unknown;
  createdAt: string;
  estimatedPromptTokens?: number;
}>): string[] {
  const lines = [`[memory] injecting ${cards.length} card${cards.length === 1 ? "" : "s"}`];

  for (const card of cards) {
    lines.push(`│ /${card.procedure} @ ${card.createdAt}`);
    lines.push(`│   input: ${summarizeText(card.input, 140)}`);

    if (card.summary) {
      lines.push(`│   summary: ${summarizeText(card.summary, 220)}`);
    }

    if (card.memory) {
      lines.push(`│   memory: ${summarizeText(card.memory, 280)}`);
    }

    if (card.dataRef) {
      lines.push(`│   result_ref: ${formatValueRefInline(card.dataRef)}`);
    }

    if (card.displayRef) {
      lines.push(`│   display_ref: ${formatValueRefInline(card.displayRef)}`);
    }

    if (card.dataPreview) {
      lines.push(`│   data_preview: ${summarizeText(card.dataPreview, 220)}`);
    }

    if (card.dataShape !== undefined) {
      lines.push(`│   data_shape: ${summarizeText(JSON.stringify(card.dataShape), 220)}`);
    }

    if (card.estimatedPromptTokens !== undefined) {
      lines.push(`│   estimated_tokens: ${formatInt(card.estimatedPromptTokens)}`);
    }
  }

  return lines;
}

export function formatStoredMemoryCardLines(
  card: {
    procedure: string;
    input: string;
    summary?: string;
    memory?: string;
    dataRef?: ValueRef;
    displayRef?: ValueRef;
    dataPreview?: string;
    dataShape?: unknown;
    createdAt: string;
    estimatedPromptTokens?: number;
  },
  estimate?: { method?: string; encoding?: string },
): string[] {
  const lines = [`[memory] stored /${card.procedure} @ ${card.createdAt}`];
  lines.push(...formatMemoryCardsLines([card]).slice(1));
  if (card.estimatedPromptTokens !== undefined) {
    const suffix = estimate?.method && estimate.encoding
      ? ` via ${estimate.method}/${estimate.encoding}`
      : "";
    lines.push(`│   future_visible_context_tokens: ${formatInt(card.estimatedPromptTokens)}${suffix}`);
  }
  return lines;
}

export function formatPromptDiagnosticsLine(diagnostics: {
  method: string;
  encoding: string;
  totalTokens: number;
  userMessageTokens: number;
  memoryCardsTokens?: number;
  guidanceTokens?: number;
}): string {
  const parts = [
    `visible prompt ${formatInt(diagnostics.totalTokens)}`,
    `user ${formatInt(diagnostics.userMessageTokens)}`,
  ];

  if (diagnostics.memoryCardsTokens !== undefined) {
    parts.push(`memory ${formatInt(diagnostics.memoryCardsTokens)}`);
  }

  if (diagnostics.guidanceTokens !== undefined) {
    parts.push(`guidance ${formatInt(diagnostics.guidanceTokens)}`);
  }

  return `[prompt] local ${diagnostics.method}/${diagnostics.encoding}: ${parts.join(", ")}`;
}

export function formatTokenUsageLine(usage: AgentTokenUsage): string {
  if (usage.currentContextTokens !== undefined && usage.maxContextTokens !== undefined) {
    const percent = getAgentTokenUsagePercent(usage) ?? 0;
    return `[tokens] ${formatInt(usage.currentContextTokens)} / ${formatInt(usage.maxContextTokens)} (${percent.toFixed(1)}%)`;
  }

  if (usage.currentContextTokens !== undefined) {
    return `[tokens] ${formatInt(usage.currentContextTokens)}`;
  }

  return `[tokens] ${usage.source}`;
}

export function formatElapsedRunTimer(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `[time] ${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `[time] ${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatValueRefInline(valueRef: ValueRef): string {
  return `session=${valueRef.cell.sessionId} cell=${valueRef.cell.cellId} path=${valueRef.path}`;
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
