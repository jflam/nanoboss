import type { NanobossTuiTheme } from "../theme/theme.ts";

export function formatDiffLine(theme: NanobossTuiTheme, line: string): string {
  if (
    line.startsWith("diff --git ")
    || line.startsWith("index ")
    || line.startsWith("--- ")
    || line.startsWith("+++ ")
    || line.startsWith("*** ")
  ) {
    return theme.toolCardMeta(line);
  }

  if (line.startsWith("@@")) {
    return theme.toolCardAccent(line);
  }

  if (line.startsWith("+")) {
    return theme.toolCardSuccess(line);
  }

  if (line.startsWith("-")) {
    return theme.toolCardError(line);
  }

  return theme.toolCardBody(line);
}

export function looksLikeDiffBlock(lines: string[]): boolean {
  let hasUnifiedFileHeaders = false;
  let hasUnifiedHunk = false;
  let hasGitDiffHeader = false;
  let hasApplyPatchHeader = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      hasGitDiffHeader = true;
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      hasUnifiedFileHeaders = true;
    } else if (line.startsWith("@@")) {
      hasUnifiedHunk = true;
    } else if (
      line.startsWith("*** Begin Patch")
      || line.startsWith("*** Update File:")
      || line.startsWith("*** Add File:")
      || line.startsWith("*** Delete File:")
      || line.startsWith("*** Move to:")
    ) {
      hasApplyPatchHeader = true;
    }
  }

  return hasApplyPatchHeader || (hasUnifiedFileHeaders && hasUnifiedHunk) || (hasGitDiffHeader && (hasUnifiedFileHeaders || hasUnifiedHunk));
}
