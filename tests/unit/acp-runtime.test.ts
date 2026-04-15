import { describe, expect, test } from "bun:test";

import {
  describeBlockedNanobossAccess,
  getAgentTranscriptDir,
  getNanobossHome,
} from "@nanoboss/agent-acp";

describe("describeBlockedNanobossAccess", () => {
  test("blocks direct reads from the global agent transcript directory", () => {
    const blocked = describeBlockedNanobossAccess({
      kind: "read",
      rawInput: {
        path: `${getAgentTranscriptDir()}/example.jsonl`,
      },
    });

    expect(blocked).toContain("agent-logs");
  });

  test("blocks broad shell scans of ~/.nanoboss", () => {
    const blocked = describeBlockedNanobossAccess({
      kind: "search",
      rawInput: {
        command: [
          "/bin/zsh",
          "-lc",
          'rg -n "session" ~/.nanoboss -S',
        ],
      },
    });

    expect(blocked).toContain("Broad access to ~/.nanoboss is blocked");
  });

  test("blocks broad shell scans of the absolute nanoboss home path", () => {
    const blocked = describeBlockedNanobossAccess({
      kind: "execute",
      rawInput: {
        command: [
          "/bin/zsh",
          "-lc",
          `find ${getNanobossHome()} -maxdepth 1 -type f`,
        ],
      },
    });

    expect(blocked).toContain("Broad access to ~/.nanoboss is blocked");
  });

  test("allows scoped filesystem fallback into specific nanoboss session files", () => {
    const allowed = describeBlockedNanobossAccess({
      kind: "search",
      rawInput: {
        command: [
          "/bin/zsh",
          "-lc",
          `rg -n "sessionId" ${getNanobossHome()}/sessions/demo-session ${getNanobossHome()}/current-sessions.json -S`,
        ],
      },
    });

    expect(allowed).toBeUndefined();
  });

  test("allows repo-local .nanoboss searches", () => {
    const allowed = describeBlockedNanobossAccess({
      kind: "search",
      rawInput: {
        command: [
          "/bin/zsh",
          "-lc",
          'rg -n "simplify2" .nanoboss docs procedures -S',
        ],
      },
    });

    expect(allowed).toBeUndefined();
  });
});
