/**
 * Machine-readable report.
 *
 * Shaped for two consumers: a CI step that needs a pass/fail and a count, and a
 * coding agent that needs enough context to act on a finding without re-reading
 * the diff. Hence both `message` (human) and the structured `evidence` array.
 *
 * Versioned from the start so that the schema can move during POC without
 * silently breaking anything built against it.
 */

import type { ScanResult } from "../core/types.ts";

export const SCHEMA_VERSION = 1;

export interface JsonReport {
  schemaVersion: number;
  tool: { name: string; version: string };
  range: string;
  summary: ScanResult["summary"] & { bySeverity: Record<string, number>; byRule: Record<string, number> };
  findings: Array<{
    rule: string;
    severity: string;
    class: string;
    confidence: number;
    file: string;
    line: number;
    productionFile?: string;
    productionLine?: number;
    testName?: string;
    message: string;
    rationale?: string;
    evidence: Array<{ label: string; before?: string; after?: string; detail?: string }>;
  }>;
}

export function toJsonReport(result: ScanResult, version = "0.0.0-poc.0"): JsonReport {
  const bySeverity: Record<string, number> = { high: 0, medium: 0, low: 0 };
  const byRule: Record<string, number> = {};
  for (const f of result.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "testslop", version },
    range: result.range,
    summary: { ...result.summary, bySeverity, byRule },
    findings: result.findings.map((f) => ({
      rule: f.ruleId,
      severity: f.severity,
      class: f.class,
      confidence: f.confidence,
      file: f.file,
      line: f.line,
      ...(f.productionFile ? { productionFile: f.productionFile } : {}),
      ...(f.productionLine ? { productionLine: f.productionLine } : {}),
      ...(f.testName ? { testName: f.testName } : {}),
      message: f.message,
      ...(f.rationale ? { rationale: f.rationale } : {}),
      evidence: f.evidence.map((e) => ({
        label: e.label,
        ...(e.before !== undefined ? { before: e.before } : {}),
        ...(e.after !== undefined ? { after: e.after } : {}),
        ...(e.detail !== undefined ? { detail: e.detail } : {}),
      })),
    })),
  };
}
