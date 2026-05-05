import { registerKeyBinding, type KeyBinding } from "./bindings.ts";
import {
  getCoreCustomBindings,
  getCoreRunBindings,
  getCoreToolBindings,
} from "./core-bindings-actions.ts";
import { buildKeybindingsHelpMarkdown } from "./core-bindings-help.ts";

/**
 * Core bindings shipped with @nanoboss/adapters-tui. Registered for side
 * effects when this module is imported. Each binding's `run` delegates to
 * controller/app hooks surfaced through BindingCtx so registrations stay
 * free of instance state.
 */

const CORE_BINDINGS: KeyBinding[] = [
  // send/compose — enter and shift+enter are consumed by the pi-tui
  // Editor itself; we register them as docs-only so the overlay can list
  // them without re-implementing editor behavior.
  {
    id: "compose.submit",
    category: "compose",
    label: "enter send",
    order: 0,
  },
  {
    id: "compose.newline",
    category: "compose",
    label: "shift+enter newline",
    order: 1,
  },

  // tools
  ...getCoreToolBindings(),

  // run control
  ...getCoreRunBindings(),

  // theme — slash commands, docs-only in the overlay.
  {
    id: "theme.light",
    category: "theme",
    label: "/light",
    order: 0,
  },
  {
    id: "theme.dark",
    category: "theme",
    label: "/dark",
    order: 1,
  },

  // commands — slash commands, docs-only in the overlay.
  {
    id: "commands.new",
    category: "commands",
    label: "/new",
    order: 0,
  },
  {
    id: "commands.model",
    category: "commands",
    label: "/model",
    order: 1,
  },
  {
    id: "commands.help",
    category: "commands",
    label: "/help",
    order: 2,
  },
  {
    id: "commands.quit",
    category: "commands",
    label: "/quit",
    order: 3,
  },
  {
    id: "commands.dismiss",
    category: "commands",
    label: "/dismiss",
    order: 4,
  },

  // overlay
  {
    id: "overlay.toggle",
    category: "overlay",
    match: "ctrl+h",
    label: "ctrl+h keys",
    order: 0,
    run: ({ controller }) => {
      controller.showLocalCard({
        title: "Keybindings",
        markdown: buildKeybindingsHelpMarkdown(),
        severity: "info",
      });
      return { consume: true };
    },
  },

  // custom — clipboard paste and ctrl+c exit are not user-facing "keys"
  // entries in the overlay today; they live under the "custom" category
  // but remain dispatched through the registry.
  ...getCoreCustomBindings(),
];

for (const binding of CORE_BINDINGS) {
  registerKeyBinding(binding);
}
