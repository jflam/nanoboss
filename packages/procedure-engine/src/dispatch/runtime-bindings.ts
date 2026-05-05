import type { DownstreamAgentSelection } from "@nanoboss/contracts";

import { resolveDownstreamAgentConfig } from "../agent-config.ts";
import type { RuntimeBindings } from "../context/shared.ts";

export function createProcedureDispatchRuntimeBindings(
  cwd: string,
  defaultAgentSelection: DownstreamAgentSelection | undefined,
): RuntimeBindings {
  let defaultAgentConfig = resolveDownstreamAgentConfig(cwd, defaultAgentSelection);
  return {
    getDefaultAgentConfig: () => defaultAgentConfig,
    setDefaultAgentSelection: (selection) => {
      const nextConfig = resolveDownstreamAgentConfig(cwd, selection);
      defaultAgentConfig = nextConfig;
      return nextConfig;
    },
  };
}
