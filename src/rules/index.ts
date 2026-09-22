import type { Rule } from "../core/types.ts";
import { assertionRemoved, assertionWeakened } from "./assertion-weakened.ts";
import { expectedChasingImplementation } from "./expected-chasing-implementation.ts";
import { mockOnlyTest, selfDerivedOracle, weakNewTest } from "./weak-oracle.ts";
import {
  coverageIgnoreAdded,
  exceptionBroadened,
  mockScopeExpanded,
  snapshotReplacedAssertion,
  testDisabled,
  testOnlyProductionPath,
  testRemoved,
} from "./degradation.ts";

/**
 * Rule ordering is the report ordering within a severity band, so the rules that
 * tell the most complete story come first.
 */
export const ALL_RULES: Rule[] = [
  assertionWeakened,
  expectedChasingImplementation,
  testDisabled,
  assertionRemoved,
  selfDerivedOracle,
  testOnlyProductionPath,
  mockScopeExpanded,
  snapshotReplacedAssertion,
  exceptionBroadened,
  mockOnlyTest,
  weakNewTest,
  coverageIgnoreAdded,
  testRemoved,
];

export function rulesByIds(ids: string[] | undefined): Rule[] {
  if (!ids || ids.length === 0) return ALL_RULES;
  const set = new Set(ids);
  return ALL_RULES.filter((r) => set.has(r.id));
}

export function excludeRules(rules: Rule[], ids: string[] | undefined): Rule[] {
  if (!ids || ids.length === 0) return rules;
  const set = new Set(ids);
  return rules.filter((r) => !set.has(r.id));
}
