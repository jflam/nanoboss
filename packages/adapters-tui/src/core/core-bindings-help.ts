import { listKeyBindings, type KeyBindingCategory } from "./bindings.ts";

const HELP_GROUPS: { category: KeyBindingCategory; label: string }[] = [
  { category: "compose", label: "Send / compose" },
  { category: "tools", label: "Tools" },
  { category: "run", label: "Run control" },
  { category: "theme", label: "Theme" },
  { category: "commands", label: "Commands" },
  { category: "overlay", label: "Overlay" },
];

/**
 * Build the markdown body rendered inside the Keybindings card that
 * appears when the user presses ctrl+h. We intentionally exclude the
 * `custom` category (ctrl+v, ctrl+c) to match the previous in-chrome
 * overlay's visible surface.
 */
export function buildKeybindingsHelpMarkdown(): string {
  const all = listKeyBindings();
  const sections: string[] = [];
  for (const group of HELP_GROUPS) {
    const entries = all.filter((b) => b.category === group.category);
    if (entries.length === 0) continue;
    const lines = entries.map((b) => `- ${b.label}`);
    sections.push(`**${group.label}**\n\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}
