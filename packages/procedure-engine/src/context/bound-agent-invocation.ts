import type {
  AgentInvocationApi,
  AgentSessionMode,
  BoundAgentInvocationApi,
  CommandCallAgentOptions,
  KernelValue,
  RunResult,
  TypeDescriptor,
} from "@nanoboss/procedure-sdk";

import { isTypeDescriptor } from "./type-descriptor.ts";

export class BoundAgentInvocationApiImpl implements BoundAgentInvocationApi {
  constructor(
    private readonly agent: AgentInvocationApi,
    private readonly sessionMode: AgentSessionMode,
  ) {}

  async run(
    prompt: string,
    options?: Omit<CommandCallAgentOptions, "session">,
  ): Promise<RunResult<string>>;
  async run<T extends KernelValue>(
    prompt: string,
    descriptor: TypeDescriptor<T>,
    options?: Omit<CommandCallAgentOptions, "session">,
  ): Promise<RunResult<T>>;
  async run<T extends KernelValue>(
    prompt: string,
    descriptorOrOptions?: TypeDescriptor<T> | Omit<CommandCallAgentOptions, "session">,
    maybeOptions?: Omit<CommandCallAgentOptions, "session">,
  ) {
    const descriptor = isTypeDescriptor(descriptorOrOptions)
      ? descriptorOrOptions
      : undefined;
    const options = (descriptor ? maybeOptions : descriptorOrOptions) as Omit<CommandCallAgentOptions, "session"> | undefined;
    const boundOptions: CommandCallAgentOptions = {
      ...(options ?? {}),
      session: this.sessionMode,
    };

    if (descriptor) {
      return await this.agent.run(prompt, descriptor, boundOptions);
    }

    return await this.agent.run(prompt, boundOptions);
  }
}
