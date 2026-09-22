/**
 * Human-readable report.
 *
 * Priorities, in order: the reviewer should be able to (1) see whether anything
 * needs attention without reading, (2) understand a single finding without
 * opening the file, (3) disagree with it. That third one is why every finding
 * prints its before/after evidence rather than only a message — a finding a
 * reviewer cannot check is a finding they will learn to ignore.
 */

import type { Finding, ScanResult, Severity } from "../core/types.ts";

const useColor = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
};

const c = {
  dim: (s: string) => (useColor() ? `\x1b[2m${s}\x1b[22m` : s),
  bold: (s: string) => (useColor() ? `\x1b[1m${s}\x1b[22m` : s),
  red: (s: string) => (useColor() ? `\x1b[31m${s}\x1b[39m` : s),
  yellow: (s: string) => (useColor() ? `\x1b[33m${s}\x1b[39m` : s),
  blue: (s: string) => (useColor() ? `\x1b[34m${s}\x1b[39m` : s),
  green: (s: string) => (useColor() ? `\x1b[32m${s}\x1b[39m` : s),
  magenta: (s: string) => (useColor() ? `\x1b[35m${s}\x1b[39m` : s),
};

const SEVERITY_LABEL: Record<Severity, string> = { high: "HIGH", medium: "MED ", low: "LOW " };

function paintSeverity(sev: Severity): string {
  const label = SEVERITY_LABEL[sev];
  if (sev === "high") return c.red(c.bold(label));
  if (sev === "medium") return c.yellow(label);
  return c.blue(label);
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function wrap(text: string, width: number, pad: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => pad + l).join("\n");
}

export interface RenderOptions {
  /** Suppress the evidence blocks for a compact listing. */
  compact?: boolean;
  width?: number;
}

export function renderFinding(f: Finding, opts: RenderOptions = {}): string {
  const width = opts.width ?? 78;
  const out: string[] = [];
  const tag = f.class === "evidence" ? c.magenta(" [verified by experiment]") : "";

  out.push(`${paintSeverity(f.severity)}  ${c.bold(f.ruleId)}${tag}`);
  out.push(`      ${c.dim(`${f.file}:${f.line}`)}`);
  if (f.testName) out.push(`      ${c.dim(f.testName)}`);
  out.push("");
  out.push(wrap(f.message, width, "      "));

  if (!opts.compact) {
    for (const ev of f.evidence) {
      out.push("");
      out.push(`      ${c.dim(ev.label + ":")}`);
      if (ev.before !== undefined) out.push(indent(ev.before.split("\n").map((l) => c.red(`- ${l}`)).join("\n"), "      "));
      if (ev.after !== undefined) out.push(indent(ev.after.split("\n").map((l) => c.green(`+ ${l}`)).join("\n"), "      "));
      if (ev.detail) out.push(indent(c.dim(ev.detail), "      "));
    }
    if (f.rationale) {
      out.push("");
      out.push(wrap(c.dim(f.rationale), width, "      "));
    }
  }

  if (f.productionFile && !opts.compact) {
    out.push("");
    out.push(`      ${c.dim(`related production change: ${f.productionFile}${f.productionLine ? ":" + f.productionLine : ""}`)}`);
  }

  return out.join("\n");
}

export function renderReport(result: ScanResult, opts: RenderOptions = {}): string {
  const out: string[] = [];
  // ASCII separator: Windows terminals in non-UTF-8 code pages mangle box-drawing
  // characters, and a report full of question marks does not inspire confidence.
  const rule = "-".repeat(58);

  out.push("");
  out.push(c.bold("TestSlop"));
  out.push(c.dim(rule));
  out.push("");
  out.push(`Comparing         ${c.bold(result.range)}`);
  out.push(`Changed tests     ${result.summary.testFilesChanged} file(s), ${result.summary.testCasesChanged} test case(s)`);
  out.push(`Changed prod      ${result.summary.productionFilesChanged} file(s)`);
  out.push("");

  const notAnalysed = result.summary.notAnalysed ?? [];

  if (result.findings.length === 0) {
    out.push(c.green("No review-worthy changes to the test oracle found."));
    if (notAnalysed.length > 0) {
      out.push("");
      out.push(renderNotAnalysed(notAnalysed));
    }
    out.push("");
    out.push(c.dim(`Scanned in ${result.summary.durationMs} ms.`));
    out.push("");
    return out.join("\n");
  }

  out.push(c.dim(rule));
  out.push("");
  for (const f of result.findings) {
    out.push(renderFinding(f, opts));
    out.push("");
    out.push("");
  }

  out.push(c.dim(rule));
  out.push("");

  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of result.findings) counts[f.severity] += 1;
  const evidence = result.findings.filter((f) => f.class === "evidence").length;

  const parts: string[] = [];
  if (counts.high) parts.push(`${counts.high} high`);
  if (counts.medium) parts.push(`${counts.medium} medium`);
  if (counts.low) parts.push(`${counts.low} low`);

  out.push(
    `${c.bold(String(result.findings.length))} finding${result.findings.length === 1 ? "" : "s"} need review  ${c.dim(`(${parts.join(", ")})`)}`,
  );
  if (evidence > 0) {
    out.push(c.magenta(`${evidence} backed by an executed mutation experiment`));
  }
  if (notAnalysed.length > 0) {
    out.push("");
    out.push(renderNotAnalysed(notAnalysed));
  }
  out.push("");
  const total = result.summary.durationMs + (result.summary.mutationDurationMs ?? 0);
  out.push(
    c.dim(
      result.summary.mutationDurationMs !== undefined
        ? `Static analysis ${result.summary.durationMs} ms, mutation ${result.summary.mutationDurationMs} ms, total ${total} ms.`
        : `Scanned in ${result.summary.durationMs} ms.`,
    ),
  );
  out.push("");

  return out.join("\n");
}

/**
 * Coverage caveats. A scan that analysed nothing must not read like a scan that
 * found nothing, so this block is printed in both the empty and non-empty cases.
 */
function renderNotAnalysed(entries: Array<{ file: string; reason: string }>): string {
  const lines: string[] = [];
  lines.push(c.yellow(`Not fully analysed (${entries.length} file${entries.length === 1 ? "" : "s"}):`));
  for (const e of entries.slice(0, 6)) {
    lines.push(c.dim(`  ${e.file}`));
    lines.push(c.dim(`    ${e.reason}`));
  }
  if (entries.length > 6) lines.push(c.dim(`  … and ${entries.length - 6} more`));
  return lines.join("\n");
}

export function renderRuleList(
  rules: Array<{ id: string; title: string; uniqueness: string; diffAware: boolean; baseConfidence: number }>,
): string {
  const out: string[] = [""];
  out.push(c.bold("TestSlop rules"));
  out.push("");
  for (const r of rules) {
    out.push(`${c.bold(r.id)}${r.diffAware ? c.dim("  [needs diff]") : ""}`);
    out.push(wrap(r.title, 76, "  "));
    out.push(wrap(c.dim("vs existing tools: " + r.uniqueness), 76, "  "));
    out.push("");
  }
  return out.join("\n");
}
