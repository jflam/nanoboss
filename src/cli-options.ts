import {
  parseFrontendConnectionOptions,
  type FrontendConnectionOptions,
} from "./options/frontend-connection.ts";

export interface CliOptions extends FrontendConnectionOptions {}

export function parseCliOptions(argv: string[]): CliOptions {
  const { remainingArgs: _remainingArgs, ...options } = parseFrontendConnectionOptions(argv);
  return options;
}
