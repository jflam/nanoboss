import {
  getSignalExitCode,
  type TuiExitSignal,
} from "./run-terminal.ts";

interface TuiRunExitReportOptions {
  sessionId?: string;
  exitSignal?: TuiExitSignal;
  writeStderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

export function reportTuiRunExit(options: TuiRunExitReportOptions): void {
  if (options.sessionId) {
    options.writeStderr(`nanoboss session id: ${options.sessionId}\n`);
  }
  if (options.exitSignal) {
    options.setExitCode(getSignalExitCode(options.exitSignal));
  }
}
