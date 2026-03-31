import { expect, test } from "bun:test";

import { parseAgentModelSelection, resolveDownstreamAgentConfig } from "../../src/config.ts";

test("resolveDownstreamAgentConfig maps claude selections to the ACP adapter", () => {
  const config = resolveDownstreamAgentConfig("/repo", {
    provider: "claude",
    model: "opus",
  });

  expect(config.provider).toBe("claude");
  expect(config.command).toBe("claude-code-acp");
  expect(config.args).toEqual([]);
  expect(config.cwd).toBe("/repo");
  expect(config.model).toBe("opus");
  expect(config.env).toEqual({
    ANTHROPIC_API_KEY: "",
    CLAUDE_API_KEY: "",
  });
});

test("resolveDownstreamAgentConfig parses copilot reasoning-effort suffixes", () => {
  const config = resolveDownstreamAgentConfig("/repo", {
    provider: "copilot",
    model: "gpt-5.4/xhigh",
  });

  expect(config.provider).toBe("copilot");
  expect(config.command).toBe("copilot");
  expect(config.args).toEqual(["--acp", "--allow-all-tools"]);
  expect(config.model).toBe("gpt-5.4");
  expect(config.reasoningEffort).toBe("xhigh");
});

test("parseAgentModelSelection leaves non-copilot slash suffixes unchanged", () => {
  const parsed = parseAgentModelSelection("codex", "gpt-5.4/xhigh");

  expect(parsed.modelId).toBe("gpt-5.4/xhigh");
  expect(parsed.reasoningEffort).toBeUndefined();
});

test("resolveDownstreamAgentConfig still supports raw env overrides", () => {
  const originalCommand = process.env.NANO_AGENTBOSS_AGENT_CMD;
  const originalArgs = process.env.NANO_AGENTBOSS_AGENT_ARGS;

  process.env.NANO_AGENTBOSS_AGENT_CMD = "custom-agent";
  process.env.NANO_AGENTBOSS_AGENT_ARGS = "[\"--foo\",\"bar\"]";

  try {
    const config = resolveDownstreamAgentConfig("/repo");

    expect(config.command).toBe("custom-agent");
    expect(config.args).toEqual(["--foo", "bar"]);
    expect(config.cwd).toBe("/repo");
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
  } finally {
    if (originalCommand === undefined) {
      delete process.env.NANO_AGENTBOSS_AGENT_CMD;
    } else {
      process.env.NANO_AGENTBOSS_AGENT_CMD = originalCommand;
    }

    if (originalArgs === undefined) {
      delete process.env.NANO_AGENTBOSS_AGENT_ARGS;
    } else {
      process.env.NANO_AGENTBOSS_AGENT_ARGS = originalArgs;
    }
  }
});
