import { getAgentTokenUsagePercent } from "../token-usage.ts";
import type { AgentTokenUsage, ValueRef } from "../types.ts";

export function isWrapperToolTitle(title: string): boolean {
  return (
    title.startsWith("callAgent") ||
    title.startsWith("defaultSession:") ||
    title.includes("procedure_dispatch")
  );
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
    lines.push(`│   input: ${summarizeInline(card.input, 140)}`);

    if (card.summary) {
      lines.push(`│   summary: ${summarizeInline(card.summary, 220)}`);
    }

    if (card.memory) {
      lines.push(`│   memory: ${summarizeInline(card.memory, 280)}`);
    }

    if (card.dataRef) {
      lines.push(`│   result_ref: ${formatValueRefInline(card.dataRef)}`);
    }

    if (card.displayRef) {
      lines.push(`│   display_ref: ${formatValueRefInline(card.displayRef)}`);
    }

    if (card.dataPreview) {
      lines.push(`│   data_preview: ${summarizeInline(card.dataPreview, 220)}`);
    }

    if (card.dataShape !== undefined) {
      lines.push(`│   data_shape: ${summarizeInline(JSON.stringify(card.dataShape), 220)}`);
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
    const suffix = estimate?.method && estimate?.encoding
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

function formatValueRefInline(valueRef: ValueRef): string {
  return `session=${valueRef.cell.sessionId} cell=${valueRef.cell.cellId} path=${valueRef.path}`;
}

function summarizeInline(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
