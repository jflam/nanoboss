import { describe, expect, test } from "bun:test";

import { NanobossTuiApp } from "../../src/tui/app.ts";
import { createInitialUiState, type UiState } from "../../src/tui/state.ts";
import { createNanobossTuiTheme } from "../../src/tui/theme.ts";

class FakeEditor {
  text = "";
  disableSubmit = false;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  history: string[] = [];
  autocompleteProvider?: unknown;

  addToHistory(text: string): void {
    this.history.push(text);
  }

  setText(text: string): void {
    this.text = text;
    this.onChange?.(text);
  }

  getText(): string {
    return this.text;
  }

  setAutocompleteProvider(provider: unknown): void {
    this.autocompleteProvider = provider;
  }

  submit(): void {
    if (!this.disableSubmit) {
      this.onSubmit?.(this.text);
    }
  }
}

describe("NanobossTuiApp", () => {
  test("keeps pi-tui submit enabled for steering input while a run is active", () => {
    const editor = new FakeEditor();
    const handledSubmissions: string[] = [];
    let currentState: UiState = createInitialUiState({
      cwd: "/repo",
      showToolCalls: true,
    });
    let capturedOnStateChange: ((state: UiState) => void) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener() {},
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit(text: string) {
              handledSubmissions.push(text);
            },
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {},
            requestExit() {},
            async run() {
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => ({
          setState() {},
        }),
      },
    );

    editor.setText("hello");
    currentState = {
      ...currentState,
      inputDisabled: true,
    };
    capturedOnStateChange?.(currentState);
    expect(editor.disableSubmit).toBe(false);

    editor.setText("steer here");
    expect(editor.disableSubmit).toBe(false);

    editor.submit();
    expect(handledSubmissions).toEqual(["steer here"]);
  });

  test("pressing ctrl+o toggles expanded tool output", async () => {
    const editor = new FakeEditor();
    const toggles: string[] = [];
    const currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
            getState: () => currentState,
            async handleSubmit() {},
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {
              toggles.push("toggle");
          },
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => ({
          setState() {},
        }),
      },
    );

    const result = inputListener?.("\u000f");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(toggles).toEqual(["toggle"]);
  });

  test("pressing escape while a run is active cancels the current run", async () => {
    const editor = new FakeEditor();
    const cancellations: string[] = [];
    const currentState: UiState = {
      ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
      inputDisabled: true,
    };
    let capturedOnStateChange: ((state: UiState) => void) | undefined;
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit() {},
            async queuePrompt() {},
            async cancelActiveRun() {
              cancellations.push("cancel");
            },
            toggleToolOutput() {},
            requestExit() {},
            async run() {
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => ({
          setState() {},
        }),
      },
    );

    capturedOnStateChange?.(currentState);
    const result = inputListener?.("\u001b");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(cancellations).toEqual(["cancel"]);
  });

  test("pressing tab while a run is active queues the current input", async () => {
    const editor = new FakeEditor();
    const queued: string[] = [];
    const currentState: UiState = {
      ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
      inputDisabled: true,
    };
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
          getState: () => currentState,
          async handleSubmit() {},
          async queuePrompt(text: string) {
            queued.push(text);
          },
          async cancelActiveRun() {},
          toggleToolOutput() {},
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => ({
          setState() {},
        }),
      },
    );

    editor.setText("after this");
    const result = inputListener?.("\t");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(queued).toEqual(["after this"]);
  });

  test("refreshes the view while an active run is in progress so the timer can advance", async () => {
    const editor = new FakeEditor();
    let currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let capturedOnStateChange: ((state: UiState) => void) | undefined;
    let setStateCalls = 0;
    const intervalCallbacks: Array<() => void> = [];
    const clearedIntervals: number[] = [];

    const app = new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener() {},
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit() {},
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {},
            requestExit() {},
            async run() {
              currentState = {
                ...currentState,
                inputDisabled: true,
                runStartedAtMs: 1_000,
              };
              capturedOnStateChange?.(currentState);
              intervalCallbacks[0]?.();
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => ({
          setState() {
            setStateCalls += 1;
          },
        }),
        setInterval(callback: () => void) {
          intervalCallbacks.push(callback);
          return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval(handle) {
          clearedIntervals.push(Number(handle));
        },
      },
    );

    await app.run();

    expect(setStateCalls).toBe(3);
    expect(clearedIntervals).toEqual([1]);
  });

  test("applies local tool card theme changes to the shared theme instance", () => {
    const editor = new FakeEditor();
    const theme = createNanobossTuiTheme();
    let currentState: UiState = createInitialUiState({
      cwd: "/repo",
      showToolCalls: true,
    });
    let capturedOnStateChange: ((state: UiState) => void) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTheme: () => theme,
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener() {},
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit() {},
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {},
            requestExit() {},
            async run() {
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => ({
          setState() {},
        }),
      },
    );

    expect(theme.getToolCardMode()).toBe("dark");

    currentState = {
      ...currentState,
      toolCardThemeMode: "light",
    };
    capturedOnStateChange?.(currentState);

    expect(theme.getToolCardMode()).toBe("light");
  });
});
