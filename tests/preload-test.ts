import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), "nanoboss-test-home-"));

process.env.HOME = testHome;
process.env.NANOBOSS_TEST_HOME = testHome;

process.on("exit", () => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures during test shutdown.
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  delete process.env.NANOBOSS_TEST_HOME;
});
