export type RestoreTerminalInput = () => void | Promise<void>;
export type TuiExitSignal = "SIGINT" | "SIGTERM";

const RESERVED_TTY_CONTROL_CHARACTERS = [
  "discard",
  "dsusp",
] as const;

export async function suspendReservedControlCharacters(): Promise<RestoreTerminalInput | undefined> {
  if (process.platform === "win32" || !process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const ttyArgs = getSttyTargetArgs();
  if (!ttyArgs) {
    return undefined;
  }

  const savedState = runStty([...ttyArgs, "-g"]);
  if (!savedState || savedState.exitCode !== 0) {
    return undefined;
  }

  const encodedState = readProcessText(savedState);
  if (!encodedState) {
    return undefined;
  }

  let changed = false;
  for (const controlCharacter of RESERVED_TTY_CONTROL_CHARACTERS) {
    const result = runStty([...ttyArgs, controlCharacter, "undef"]);
    if (result && result.exitCode === 0) {
      changed = true;
    }
  }

  if (!changed) {
    return undefined;
  }

  return () => {
    void runStty([...ttyArgs, encodedState]);
  };
}

export function addProcessSignalListener(signal: TuiExitSignal, listener: () => void): () => void {
  process.on(signal, listener);
  return () => {
    process.off(signal, listener);
  };
}

export function setProcessExitCode(code: number): void {
  process.exitCode = code;
}

export function getSignalExitCode(signal: TuiExitSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

function getSttyTargetArgs(): string[] | undefined {
  if (!Bun.which("stty", { PATH: process.env.PATH })) {
    return undefined;
  }

  return process.platform === "darwin" || process.platform === "freebsd"
    ? ["-f", "/dev/tty"]
    : ["-F", "/dev/tty"];
}

function runStty(args: string[]): Bun.SyncSubprocess | undefined {
  return Bun.spawnSync({
    cmd: ["stty", ...args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readProcessText(result: Bun.SyncSubprocess): string {
  const decoder = new TextDecoder();
  return `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`.trim();
}
