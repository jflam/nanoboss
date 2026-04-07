import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { CommandContextImpl, type SessionUpdateEmitter } from "../../src/core/context.ts";
import { RunLogger } from "../../src/core/logger.ts";
import { ProcedureRegistry } from "../../src/procedure/registry.ts";
import { SessionStore } from "../../src/session/index.ts";
import { describeE2E } from "./helpers.ts";

const repoRoot = process.cwd();
const fixtureTemplateDir = join(repoRoot, "tests/fixtures/linter/basic");
const tempDirs: string[] = [];

describeE2E("/linter fixture (real agent)", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const path = tempDirs.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  test(
    "fixes the fixture repo in round-based waves and leaves it lint-clean",
    async () => {
      const fixtureDir = createFixtureRepo();
      const output: string[] = [];
      const registry = new ProcedureRegistry();
      registry.loadBuiltins();
      await registry.loadFromDisk();

      const logger = new RunLogger();
      const store = new SessionStore({
        sessionId: crypto.randomUUID(),
        cwd: fixtureDir,
      });
      const ctx = new CommandContextImpl({
        cwd: fixtureDir,
        logger,
        registry,
        procedureName: "linter",
        spanId: logger.newSpan(),
        emitter: createEmitter(output),
        store,
        cell: store.startCell({
          procedure: "linter",
          input: "",
          kind: "top_level",
        }),
      });

      const linter = registry.get("linter");
      if (!linter) {
        throw new Error("Missing /linter procedure");
      }

      await linter.execute("", ctx);

      execFileSync("bun", ["../node_modules/eslint/bin/eslint.js", ".", "--cache", "--format", "json"], {
        cwd: fixtureDir,
        stdio: "pipe",
      });

      const status = execFileSync("git", ["status", "--short"], {
        cwd: fixtureDir,
        encoding: "utf8",
      }).trim();
      const commitCount = Number(
        execFileSync("git", ["rev-list", "--count", "HEAD"], {
          cwd: fixtureDir,
          encoding: "utf8",
        }).trim(),
      );
      const transcript = output.join("");

      expect(transcript).toContain("Starting linter workflow...");
      expect(transcript).toContain("Fixing 2 errors in `src/alpha.ts`...");
      expect(transcript).toContain("Fixing 1 error in `src/beta.ts`...");
      expect(transcript).toContain("Round 1 resolved 3 errors; 0 errors remain.");
      expect(transcript).toContain("Completed linter workflow: fixed 3 errors; 0 errors remain.");
      expect(status).toBe("");
      expect(commitCount).toBeGreaterThan(1);
    },
    10 * 60_000,
  );
});

function createFixtureRepo(): string {
  const dir = mkdtempSync(join(repoRoot, ".tmp-linter-fixture-"));
  tempDirs.push(dir);
  cpSync(fixtureTemplateDir, dir, { recursive: true });

  execFileSync("git", ["init", "-b", "main"], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "nanoboss test"], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.email", "nanoboss@example.com"], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["add", "."], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["commit", "-m", "Initial lint fixture"], {
    cwd: dir,
    stdio: "pipe",
  });

  return dir;
}

function createEmitter(output: string[]): SessionUpdateEmitter {
  return {
    emit(update) {
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        output.push(update.content.text);
      }
    },
    async flush() {},
  };
}
