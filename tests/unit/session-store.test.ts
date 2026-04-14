import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { ReplayableFrontendEvent } from "../../src/http/frontend-events.ts";
import type { PromptInput } from "../../src/core/types.ts";
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

  test("round-trips persisted replay events as canonical frontend payloads", () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-session-store-"));
    tempDirs.push(rootDir);

    const original = new SessionStore({
      sessionId: "session-replay",
      cwd: process.cwd(),
      rootDir,
    });

    const cell = original.startCell({
      procedure: "demo",
      input: "hello",
      kind: "top_level",
    });
    const replayEvents: ReplayableFrontendEvent[] = [
      {
        type: "text_delta",
        runId: "run-1",
        text: "hello\n",
        stream: "agent" as const,
      },
      {
        type: "run_completed",
        runId: "run-1",
        procedure: "demo",
        completedAt: "2026-04-01T10:00:00.000Z",
        cell: {
          sessionId: "session-replay",
          cellId: cell.cell.cellId,
        },
        summary: "done",
        display: "hello\n",
      },
    ];

    original.finalizeCell(cell, {
      display: "hello\n",
      summary: "done",
    }, {
      replayEvents,
    });

    const reloaded = new SessionStore({
      sessionId: "session-replay",
      cwd: process.cwd(),
      rootDir,
    });

    const stored = reloaded.topLevelRuns({ limit: 1 })[0];
    if (!stored) {
      throw new Error("Missing stored top-level run");
    }

    expect(reloaded.readCell(stored.cell).output.replayEvents).toEqual(replayEvents);
  });

  test("persists prompt image attachments under the session root and stores durable metadata", () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-session-store-"));
    tempDirs.push(rootDir);

    const store = new SessionStore({
      sessionId: "session-attachments",
      cwd: process.cwd(),
      rootDir,
    });
    const promptInput: PromptInput = {
      parts: [
        { type: "text", text: "look " },
        {
          type: "image",
          token: "[Image 1: PNG 10x10 3B]",
          mimeType: "image/png",
          data: "YWJj",
          width: 10,
          height: 10,
          byteLength: 3,
        },
      ],
    };

    const promptImages = store.persistPromptImages(promptInput);
    const persistedAgain = store.persistPromptImages(promptInput);
    const promptImage = expectDefined(promptImages?.[0], "Expected persisted prompt image");

    expect(promptImages).toHaveLength(1);
    expect(promptImage.token).toBe("[Image 1: PNG 10x10 3B]");
    expect(promptImage.mimeType).toBe("image/png");
    expect(promptImage.width).toBe(10);
    expect(promptImage.height).toBe(10);
    expect(promptImage.byteLength).toBe(3);
    expect(promptImage.attachmentPath).toMatch(/^attachments\/.+\.png$/);
    expect(promptImage.attachmentId).toMatch(/.+\.png$/);
    expect(persistedAgain).toEqual(promptImages);

    const attachmentPath = promptImage.attachmentPath;
    expect(typeof attachmentPath).toBe("string");
    if (typeof attachmentPath !== "string") {
      throw new Error("Expected prompt image attachment path");
    }

    const attachmentFile = join(rootDir, attachmentPath);
    expect(existsSync(attachmentFile)).toBe(false);
    expect(readdirSync(join(rootDir, "attachments")).filter((entry) => entry.endsWith(".tmp"))).toHaveLength(1);

    const cell = store.startCell({
      procedure: "default",
      input: "look [Image 1: PNG 10x10 3B]",
      kind: "top_level",
      promptImages,
    });
    const finalized = store.finalizeCell(cell, {
      display: "noted\n",
      summary: "noted",
    });

    const reloaded = new SessionStore({
      sessionId: "session-attachments",
      cwd: process.cwd(),
      rootDir,
    });

    expect(existsSync(attachmentFile)).toBe(true);
    expect(readFileSync(attachmentFile).toString("base64")).toBe("YWJj");
    expect(readdirSync(join(rootDir, "attachments")).filter((entry) => entry.endsWith(".tmp"))).toHaveLength(0);
    expect(reloaded.readCell(finalized.cell).meta.promptImages).toEqual(promptImages);
  });

  test("promotes staged prompt image attachments when a persisted cell is loaded after a crash window", () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-session-store-"));
    tempDirs.push(rootDir);

    const store = new SessionStore({
      sessionId: "session-attachment-recovery",
      cwd: process.cwd(),
      rootDir,
    });
    const promptInput: PromptInput = {
      parts: [
        { type: "text", text: "recover " },
        {
          type: "image",
          token: "[Image 1: PNG 10x10 3B]",
          mimeType: "image/png",
          data: "YWJj",
          width: 10,
          height: 10,
          byteLength: 3,
        },
      ],
    };

    const promptImages = expectDefined(store.persistPromptImages(promptInput), "Expected persisted prompt images");
    const attachmentPath = expectDefined(promptImages[0]?.attachmentPath, "Expected attachment path");
    const attachmentFile = join(rootDir, attachmentPath);
    const stagedFile = `${attachmentFile}.tmp`;

    expect(existsSync(stagedFile)).toBe(true);
    expect(existsSync(attachmentFile)).toBe(false);

    const draft = store.startCell({
      procedure: "default",
      input: "recover [Image 1: PNG 10x10 3B]",
      kind: "top_level",
      promptImages,
    });
    writeFileSync(
      join(rootDir, "cells", `123-${draft.cell.cellId}.json`),
      `${JSON.stringify({
        cellId: draft.cell.cellId,
        procedure: draft.procedure,
        input: draft.input,
        output: {
          display: "recovered\n",
          summary: "recovered",
        },
        meta: draft.meta,
      }, null, 2)}\n`,
      "utf8",
    );

    const reloaded = new SessionStore({
      sessionId: "session-attachment-recovery",
      cwd: process.cwd(),
      rootDir,
    });

    expect(existsSync(stagedFile)).toBe(false);
    expect(existsSync(attachmentFile)).toBe(true);
    expect(readFileSync(attachmentFile).toString("base64")).toBe("YWJj");
    expect(reloaded.topLevelRuns({ limit: 1 })[0]?.procedure).toBe("default");
  });

  test("removes stale staged attachment temp files when a store is reloaded", () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-session-store-"));
    tempDirs.push(rootDir);

    const attachmentsDir = join(rootDir, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });

    const staleTempPath = join(attachmentsDir, "stale.png.123.tmp");
    writeFileSync(staleTempPath, Buffer.from("abc"));
    const oldDate = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000));
    utimesSync(staleTempPath, oldDate, oldDate);

    const liveAttachmentPath = join(attachmentsDir, "live.png");
    writeFileSync(liveAttachmentPath, Buffer.from("xyz"));

    const store = new SessionStore({
      sessionId: "session-attachment-cleanup",
      cwd: process.cwd(),
      rootDir,
    });

    expect(store.topLevelRuns()).toEqual([]);
    expect(existsSync(staleTempPath)).toBe(false);
    expect(existsSync(liveAttachmentPath)).toBe(true);
  });
});
