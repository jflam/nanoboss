import { formatSessionDetailLine, formatSessionLine } from "../../session-picker-format.ts";
import type { StoredSessionSummary } from "../../stored-sessions.ts";

import type { NanobossTuiTheme } from "../theme.ts";
import { promptWithSelectList } from "./select-overlay.ts";

export async function promptForStoredSessionSelection(
  theme: NanobossTuiTheme,
  sessions: StoredSessionSummary[],
  cwd: string,
): Promise<StoredSessionSummary | undefined> {
  const selectedId = await promptWithSelectList(theme, {
    title: `Resume nanoboss session — ${cwd}`,
    items: sessions.map((session) => ({
      value: session.sessionId,
      label: formatSessionLine(session, cwd),
      description: formatSessionDetailLine(session),
    })),
    footer: "↑↓ navigate • enter resume • esc cancel",
    maxVisible: 10,
  });

  return sessions.find((session) => session.sessionId === selectedId);
}
