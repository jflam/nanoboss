import type { KeyBinding } from "./bindings.ts";

export function getCoreToolBindings(): KeyBinding[] {
  return [
    {
      id: "tools.toggleOutput",
      category: "tools",
      match: "ctrl+o",
      label: "ctrl+o expand tool output",
      order: 0,
      run: ({ app }) => {
        app.handleCtrlOWithCooldown();
        return { consume: true };
      },
    },
  ];
}

export function getCoreRunBindings(): KeyBinding[] {
  return [
    {
      id: "run.toggleAutoApprove",
      category: "run",
      match: "ctrl+g",
      label: "ctrl+g auto-approve",
      order: 0,
      run: ({ controller }) => {
        controller.toggleSimplify2AutoApprove();
        return { consume: true };
      },
    },
    {
      id: "run.togglePause",
      category: "run",
      match: "ctrl+p",
      label: "ctrl+p pause",
      order: 1,
      run: ({ app }) => {
        app.toggleLiveUpdatesPaused();
        return { consume: true };
      },
    },
    {
      id: "run.toggleToolCards",
      category: "run",
      match: "ctrl+t",
      label: "ctrl+t hide tool cards",
      order: 2,
      run: ({ controller }) => {
        controller.toggleToolCardsHidden();
        return { consume: true };
      },
    },
    {
      id: "run.stop",
      category: "run",
      match: "escape",
      label: "esc stop",
      order: 3,
      when: (state) => state.inputDisabledReason === "run",
      run: ({ controller, state }) => {
        if (state.inputDisabledReason === "run") {
          void controller.cancelActiveRun();
          return { consume: true };
        }
        return undefined;
      },
    },
    {
      id: "run.queue",
      category: "run",
      match: "tab",
      label: "tab queue",
      order: 4,
      when: (state) => state.inputDisabledReason === "run",
      run: ({ app }) => {
        return app.handleTabQueue() ? { consume: true } : { consume: false };
      },
    },
  ];
}

export function getCoreCustomBindings(): KeyBinding[] {
  return [
    {
      id: "custom.clipboardPaste",
      category: "custom",
      match: "ctrl+v",
      label: "ctrl+v paste image",
      order: 0,
      run: ({ app }) => {
        void app.handleCtrlVImagePaste();
        return { consume: true };
      },
    },
    {
      id: "custom.ctrlCExit",
      category: "custom",
      match: "ctrl+c",
      label: "ctrl+c clear / exit",
      order: 1,
      run: ({ app }) => {
        app.handleCtrlC();
        return { consume: true };
      },
    },
  ];
}
