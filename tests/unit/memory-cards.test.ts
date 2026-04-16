import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  collectUnsyncedProcedureMemoryCards,
  renderProcedureMemoryCardsSection,
} from "@nanoboss/app-runtime";
import { SessionStore } from "@nanoboss/store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("procedure memory cards", () => {
  test("selects only top-level non-default cells and renders a bounded preamble", () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-memory-cards-"));
    tempDirs.push(rootDir);

    const store = new SessionStore({
      sessionId: "session-1",
      cwd: process.cwd(),
      rootDir,
    });

    const reviewCell = store.startRun({
      procedure: "review",
      input: "check the diff",
      kind: "top_level",
    });
    const reviewResult = store.completeRun(reviewCell, {
      data: {
        subject: "diff",
        verdict: "mixed",
        critiqueMainIssue: "missing edge-case coverage",
      },
      display: "full rendered review output that should not be injected wholesale",
      summary: "review summary",
      memory: "Most important issue was missing edge-case coverage.",
    });

    store.completeRun(
      store.startRun({
        procedure: "default",
        input: "hello",
        kind: "top_level",
      }),
      {
        display: "hi",
      },
    );

    store.completeRun(
      store.startRun({
        procedure: "child-proc",
        input: "internal",
        kind: "procedure",
        parentRunId: reviewCell.run.runId,
      }),
      {
        display: "internal child result",
        summary: "internal",
      },
    );

    store.completeRun(
      store.startRun({
        procedure: "callAgent",
        input: "internal agent",
        kind: "agent",
        parentRunId: reviewCell.run.runId,
      }),
      {
        display: "internal agent result",
        summary: "agent",
      },
    );

    const cards = collectUnsyncedProcedureMemoryCards(store, new Set());
    expect(cards).toHaveLength(1);
    expect(cards[0]?.procedure).toBe("review");
    expect(cards[0]?.run).toEqual(reviewResult.run);
    expect(cards[0]?.memory).toContain("Most important issue");
    expect(cards[0]?.dataShape).toEqual({
      subject: "diff",
      verdict: "mixed",
      critiqueMainIssue: "string",
    });

    const cardsSection = renderProcedureMemoryCardsSection(cards);
    expect(cardsSection).toContain("Nanoboss session memory update:");
    expect(cardsSection).toContain("procedure: /review");
    expect(cardsSection).toContain("result_ref:");
    expect(cardsSection).toContain("display_ref:");
    expect(cardsSection).toContain("data_preview:");
    expect(cardsSection).toContain("critiqueMainIssue");
    expect(cardsSection).not.toContain("full rendered review output that should not be injected wholesale");
  });

  test("falls back from memory to summary", () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-memory-cards-"));
    tempDirs.push(rootDir);

    const store = new SessionStore({
      sessionId: "session-2",
      cwd: process.cwd(),
      rootDir,
    });

    store.completeRun(
      store.startRun({
        procedure: "review",
        input: "check the diff",
        kind: "top_level",
      }),
      {
        display: "display text",
        summary: "review summary fallback",
      },
    );

    const cards = collectUnsyncedProcedureMemoryCards(store, new Set());
    expect(cards[0]?.memory).toBe("review summary fallback");
  });
});
