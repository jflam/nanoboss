import {
  formatSessionDetailLine,
  formatSessionInitialPrompt,
  formatSessionLine,
} from "../../session/picker-format.ts";
import type { SessionMetadata } from "@nanoboss/contracts";

import type { NanobossTuiTheme } from "../theme.ts";
import { promptWithSelectList } from "./select-overlay.ts";

export async function promptForStoredSessionSelection(
  theme: NanobossTuiTheme,
  sessions: SessionMetadata[],
  cwd: string,
): Promise<SessionMetadata | undefined> {
  const selectedId = await promptWithSelectList(theme, {
    title: `Resume nanoboss session — ${cwd}`,
    items: sessions.map((session) => ({
      value: session.session.sessionId,
      label: formatSessionLine(session, cwd),
      description: formatSessionDetailLine(session),
    })),
    footer: "↑↓ navigate • enter resume • esc cancel",
    maxVisible: 10,
    selectedDetailTitle: "First user prompt",
    renderSelectedDetail: (item) => {
      const session = sessions.find((candidate) => candidate.session.sessionId === item.value);
      return session ? formatSessionInitialPrompt(session) : "(no turns yet)";
    },
  });

  return sessions.find((session) => session.session.sessionId === selectedId);
}
