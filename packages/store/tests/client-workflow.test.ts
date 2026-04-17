import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  SessionStore,
  readCurrentWorkspaceSessionMetadata,
  readStoredSessionMetadata,
  writeStoredSessionMetadata,
} from "@nanoboss/store";

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

describe("store client workflow", () => {
  test("shows how a client persists metadata, stores runs, traverses the graph, and materializes refs", () => {
    const originalHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), "nanoboss-store-client-"));
    tempDirs.push(tempHome);
    process.env.HOME = tempHome;

    try {
      const cwd = join(tempHome, "repo");
      const rootDir = join(tempHome, ".nanoboss", "sessions", "session-client");
      const store = new SessionStore({
        sessionId: "session-client",
        cwd,
        rootDir,
      });

      const metadata = writeStoredSessionMetadata({
        session: { sessionId: "session-client" },
        cwd,
        rootDir,
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T10:00:00.000Z",
        initialPrompt: "review this patch",
      });

      expect(readStoredSessionMetadata("session-client", rootDir)).toEqual(metadata);
      expect(readCurrentWorkspaceSessionMetadata(cwd)).toEqual(metadata);

      const reviewRun = store.startRun({
        procedure: "second-opinion",
        input: "review this patch",
        kind: "top_level",
      });
      reviewRun.meta.createdAt = "2026-04-01T10:00:01.000Z";
      const critiqueRun = store.startRun({
        procedure: "callAgent",
        input: "critique the patch",
        kind: "agent",
        parentRunId: reviewRun.run.runId,
      });
      critiqueRun.meta.createdAt = "2026-04-01T10:00:02.000Z";

      const critique = store.completeRun(critiqueRun, {
        data: {
          verdict: "mixed",
          issueCount: 2,
        },
        display: "critique output",
        summary: "agent critique",
      });
      const review = store.completeRun(reviewRun, {
        data: {
          critique: expectDefined(critique.dataRef, "Expected critique data ref"),
          verdict: "needs changes",
        },
        display: "review output",
        summary: "review summary",
        memory: "The patch still needs a regression test.",
      });

      store.patchRun(review.run, {
        output: {
          replayEvents: [
            {
              type: "run_completed",
              runId: review.run.runId,
            },
          ],
        },
      });

      const reloaded = new SessionStore({
        sessionId: "session-client",
        cwd,
        rootDir,
      });
      const reviewSummary = reloaded.listRuns()[0];
      const recentRuns = reloaded.listRuns({ scope: "recent", limit: 2 });
      const descendants = reloaded.getRunDescendants(review.run);
      const ancestors = reloaded.getRunAncestors(critique.run);
      const reviewDataRef = expectDefined(review.dataRef, "Expected review data ref");
      const exportPath = join(cwd, "exports", "review.json");

      expect(reviewSummary).toMatchObject({
        run: review.run,
        procedure: "second-opinion",
        kind: "top_level",
        summary: "review summary",
        memory: "The patch still needs a regression test.",
      });
      expect(recentRuns.map((run) => [run.procedure, run.parentRunId])).toEqual([
        ["callAgent", review.run.runId],
        ["second-opinion", undefined],
      ]);
      expect(descendants).toMatchObject([
        {
          run: critique.run,
          procedure: "callAgent",
          parentRunId: review.run.runId,
        },
      ]);
      expect(ancestors).toMatchObject([
        {
          run: review.run,
          procedure: "second-opinion",
        },
      ]);
      expect(reloaded.getRun(review.run)).toMatchObject({
        run: review.run,
        output: {
          data: {
            critique: critique.dataRef,
            verdict: "needs changes",
          },
          replayEvents: [
            {
              type: "run_completed",
              runId: review.run.runId,
            },
          ],
        },
      });
      expect(reloaded.readRef(reviewDataRef)).toEqual({
        critique: critique.dataRef,
        verdict: "needs changes",
      });
      expect(reloaded.statRef(reviewDataRef)).toMatchObject({
        run: review.run,
        path: "output.data",
        type: "object",
      });

      reloaded.writeRefToFile(reviewDataRef, "exports/review.json");

      expect(existsSync(exportPath)).toBe(true);
      expect(readFileSync(exportPath, "utf8")).toContain('"verdict": "needs changes"');
      expect(readFileSync(exportPath, "utf8")).toContain('"path": "output.data"');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
