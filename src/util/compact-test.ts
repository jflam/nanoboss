type CompactTestStatus = "." | "F" | "S";

interface CompactTestReport {
  statuses: CompactTestStatus[];
  total: number;
  passed: number;
  skipped: number;
  failed: number;
  timeSeconds?: number;
}

export function mergeCompactTestReports(
  reports: ReadonlyArray<CompactTestReport>,
  timeSeconds?: number,
): CompactTestReport {
  return {
    statuses: reports.flatMap((report) => report.statuses),
    total: reports.reduce((sum, report) => sum + report.total, 0),
    passed: reports.reduce((sum, report) => sum + report.passed, 0),
    skipped: reports.reduce((sum, report) => sum + report.skipped, 0),
    failed: reports.reduce((sum, report) => sum + report.failed, 0),
    timeSeconds,
  };
}

export function parseJunitReport(xml: string): CompactTestReport | undefined {
  const testsuitesMatch = xml.match(/<testsuites\b([^>]*)>/);
  if (!testsuitesMatch) {
    return undefined;
  }

  const statuses: CompactTestStatus[] = [];
  const testcasePattern = /<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g;
  for (const match of xml.matchAll(testcasePattern)) {
    const block = match[0];
    if (!block) {
      continue;
    }

    statuses.push(
      block.includes("<skipped")
        ? "S"
        : block.includes("<failure") || block.includes("<error")
          ? "F"
          : ".",
    );
  }

  const attrs = testsuitesMatch[1] ?? "";
  const total = parseIntegerAttr(attrs, "tests") ?? statuses.length;
  const failed = parseIntegerAttr(attrs, "failures") ?? statuses.filter((status) => status === "F").length;
  const skipped = parseIntegerAttr(attrs, "skipped") ?? statuses.filter((status) => status === "S").length;
  const passed = Math.max(0, total - failed - skipped);
  const timeSeconds = parseNumberAttr(attrs, "time");

  return {
    statuses,
    total,
    passed,
    skipped,
    failed,
    timeSeconds,
  };
}

export function extractFailureDetails(rawOutput: string): string {
  const normalized = rawOutput.replace(/\r/g, "").trimEnd();
  const withoutHeader = normalized.replace(/^bun test v[^\n]*\n+/, "");
  const summaryIndex = withoutHeader.search(/(?:^|\n)\s*\d+ pass\n/);
  const withoutSummary = summaryIndex >= 0
    ? withoutHeader.slice(0, summaryIndex)
    : withoutHeader;
  return withoutSummary.trim();
}

export function renderCompactTestOutput(
  report: CompactTestReport,
  failureDetails: string,
  markerWrapWidth = 80,
): string {
  const lines: string[] = [];
  if (report.statuses.length > 0) {
    lines.push(...wrapMarkers(report.statuses.join(""), markerWrapWidth));
  }
  lines.push(formatSummary(report));

  if (failureDetails) {
    lines.push("", failureDetails);
  }

  return `${lines.join("\n")}\n`;
}

function formatSummary(report: CompactTestReport): string {
  const timeSuffix = report.timeSeconds !== undefined
    ? ` [${formatSeconds(report.timeSeconds)}]`
    : "";
  return `${report.passed} pass, ${report.skipped} skip, ${report.failed} fail, ${report.total} total${timeSuffix}`;
}

function wrapMarkers(markers: string, width: number): string[] {
  if (width <= 0 || markers.length <= width) {
    return [markers];
  }

  const lines: string[] = [];
  for (let start = 0; start < markers.length; start += width) {
    lines.push(markers.slice(start, start + width));
  }
  return lines;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

function parseIntegerAttr(attrs: string, name: string): number | undefined {
  const value = parseAttr(attrs, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumberAttr(attrs: string, name: string): number | undefined {
  const value = parseAttr(attrs, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1];
}
