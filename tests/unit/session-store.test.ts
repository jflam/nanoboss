import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { SessionStore } from "../../src/session/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

function expectDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

describe("SessionStore", () => {
  test("loads persisted cells from disk", () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-session-store-"));
    tempDirs.push(rootDir);

    const original = new SessionStore({
      sessionId: "session-1",
      cwd: process.cwd(),
      rootDir,
    });
    const cell = original.startCell({
      procedure: "demo",
      input: "hello",
      kind: "top_level",
    });
    const result = original.finalizeCell(cell, {
      data: {
        count: 3,
        text: "hi",
      },
      display: "hi\n",
      summary: "demo summary",
      memory: "demo memory",
      explicitDataSchema: {
        type: "object",
        properties: {
          count: { type: "number" },
          text: { type: "string" },
        },
      },
    });

    const reloaded = new SessionStore({
      sessionId: "session-1",
      cwd: process.cwd(),
      rootDir,
    });

    const dataRef = result.dataRef;
    if (!dataRef) {
      throw new Error("Missing dataRef");
    }

    expect(reloaded.readRef(dataRef)).toEqual({
      count: 3,
      text: "hi",
    });

    const recent = reloaded.recent({ limit: 1 });
    const latest = recent[0];
    expect(latest?.procedure).toBe("demo");
    expect(latest?.kind).toBe("top_level");
    expect(latest?.dataRef).toEqual(result.dataRef);
    expect(latest?.displayRef).toEqual(result.displayRef);
    expect(latest?.summary).toBe("demo summary");
    expect(latest?.memory).toBe("demo memory");
    expect(latest?.dataShape).toEqual({
      count: "number",
      text: "hi",
    });
    expect(latest?.explicitDataSchema).toEqual({
      type: "object",
      properties: {
        count: { type: "number" },
        text: { type: "string" },
      },
    });
  });

  test("rebuilds parent-child indexes and traversal order after reload", () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-session-store-"));
    tempDirs.push(rootDir);

    const original = new SessionStore({
      sessionId: "session-structure",
      cwd: process.cwd(),
      rootDir,
    });

    const reviewCell = original.startCell({
      procedure: "second-opinion",
      input: "review the patch",
      kind: "top_level",
    });
    reviewCell.meta.createdAt = "2026-04-01T10:00:00.000Z";
    const childProcedureCell = original.startCell({
      procedure: "review-plan",
      input: "inspect the diff",
      kind: "procedure",
      parentCellId: reviewCell.cell.cellId,
    });
    childProcedureCell.meta.createdAt = "2026-04-01T10:00:01.000Z";
    const nestedAgentCell = original.startCell({
      procedure: "callAgent",
      input: "critique the patch",
      kind: "agent",
      parentCellId: childProcedureCell.cell.cellId,
    });
    nestedAgentCell.meta.createdAt = "2026-04-01T10:00:02.000Z";
    const siblingAgentCell = original.startCell({
      procedure: "callAgent",
      input: "summarize the patch",
      kind: "agent",
      parentCellId: reviewCell.cell.cellId,
    });
    siblingAgentCell.meta.createdAt = "2026-04-01T10:00:03.000Z";

    const nestedAgent = original.finalizeCell(nestedAgentCell, {
      data: {
        verdict: "mixed",
      },
      display: "critique",
      summary: "critique summary",
    });
    const childProcedure = original.finalizeCell(childProcedureCell, {
      data: {
        critique: expectDefined(nestedAgent.dataRef, "Expected nested agent dataRef"),
      },
      display: "plan",
      summary: "plan summary",
    });
    const siblingAgent = original.finalizeCell(siblingAgentCell, {
      display: "summary",
      summary: "summary agent",
    });
    const review = original.finalizeCell(reviewCell, {
      data: {
        plan: expectDefined(childProcedure.dataRef, "Expected child procedure dataRef"),
      },
      display: "review",
      summary: "review summary",
    });

    original.finalizeCell(
      (() => {
        const linterCell = original.startCell({
          procedure: "linter",
          input: "lint the repo",
          kind: "top_level",
        });
        linterCell.meta.createdAt = "2026-04-01T10:00:04.000Z";
        return linterCell;
      })(),
      {
        display: "lint",
        summary: "lint summary",
      },
    );

    const reloaded = new SessionStore({
      sessionId: "session-structure",
      cwd: process.cwd(),
      rootDir,
    });

    expect(reloaded.ancestors(nestedAgent.cell).map((item) => item.cell.cellId)).toEqual([
      childProcedure.cell.cellId,
      review.cell.cellId,
    ]);
    expect(reloaded.ancestors(nestedAgent.cell, { limit: 1 }).map((item) => item.cell.cellId)).toEqual([
      childProcedure.cell.cellId,
    ]);
    expect(
      reloaded.ancestors(nestedAgent.cell, { includeSelf: true, limit: 2 }).map((item) => item.cell.cellId),
    ).toEqual([
      nestedAgent.cell.cellId,
      childProcedure.cell.cellId,
    ]);
    expect(reloaded.descendants(review.cell).map((item) => item.cell.cellId)).toEqual([
      childProcedure.cell.cellId,
      nestedAgent.cell.cellId,
      siblingAgent.cell.cellId,
    ]);
    expect(reloaded.descendants(review.cell, { kind: "agent" }).map((item) => item.cell.cellId)).toEqual([
      nestedAgent.cell.cellId,
      siblingAgent.cell.cellId,
    ]);
    expect(reloaded.descendants(review.cell, { maxDepth: 1 }).map((item) => item.cell.cellId)).toEqual([
      childProcedure.cell.cellId,
      siblingAgent.cell.cellId,
    ]);
    expect(reloaded.descendants(review.cell, { kind: "agent", maxDepth: 1 }).map((item) => item.cell.cellId)).toEqual([
      siblingAgent.cell.cellId,
    ]);
    expect(reloaded.latest({ procedure: "callAgent" })?.cell.cellId).toBe(siblingAgent.cell.cellId);
    expect(reloaded.parent(nestedAgent.cell)?.cell.cellId).toBe(childProcedure.cell.cellId);
    expect(reloaded.children(review.cell).map((item) => item.cell.cellId)).toEqual([
      childProcedure.cell.cellId,
      siblingAgent.cell.cellId,
    ]);
    expect(reloaded.children(review.cell, { kind: "agent" }).map((item) => item.cell.cellId)).toEqual([
      siblingAgent.cell.cellId,
    ]);
    expect(reloaded.topLevelRuns().map((item) => item.procedure)).toEqual([
      "linter",
      "second-opinion",
    ]);
  });
});
