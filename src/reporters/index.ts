import type { ReportFormat, RouteLintReport } from "../types.js";
import { renderHtmlReport } from "./html.js";
import { renderJsonReport } from "./json.js";
import { renderSarifReport } from "./sarif.js";
import { renderTerminalReport, type TerminalReportOptions } from "./terminal.js";

export { renderHtmlReport } from "./html.js";
export { renderJsonReport, stableJson } from "./json.js";
export { renderSarifReport } from "./sarif.js";
export { renderTerminalReport, type TerminalReportOptions } from "./terminal.js";

export type RenderReportOptions = TerminalReportOptions;

export function renderReport(
  report: RouteLintReport,
  format: ReportFormat,
  options: RenderReportOptions = {},
): string {
  switch (format) {
    case "terminal":
      return renderTerminalReport(report, options);
    case "json":
      return renderJsonReport(report);
    case "sarif":
      return renderSarifReport(report);
    case "html":
      return renderHtmlReport(report);
  }
}
