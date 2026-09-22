/**
 * Pairing test cases across two revisions.
 *
 * POC-00 matched test cases by their full `describe > ... > test` title and nothing
 * else. That leaves an exploitable blind spot: rename the test while weakening its
 * assertion and the flagship rule sees a deleted test plus an unrelated new one,
 * so it reports nothing.
 *
 * The strategy here is layered, most-certain first, and every layer must be
 * *unambiguous* to fire. A wrong pairing is worse than no pairing: it invents a
 * before/after relationship between two unrelated tests and can manufacture a
 * high-severity finding out of nothing. So every heuristic layer requires both a
 * minimum score and a clear margin over the runner-up.
 */

import type { TestCase } from "./types.ts";

export type PairBasis =
  /** Identical describe path + title. */
  | "exact-title"
  /** Identical normalised body, title changed. */
  | "identical-body"
  /** Same title within the file, describe path changed. */
  | "leaf-title"
  /** High structural similarity: same subjects, same production calls. */
  | "structural"
  /** Only one test in each revision, so the mapping is forced. */
  | "singleton";

export interface CasePair {
  before: TestCase;
  after: TestCase;
  basis: PairBasis;
  /** 0..1. Consumers penalise confidence for anything below `exact-title`. */
  score: number;
}

export interface PairingResult {
  pairs: CasePair[];
  /** Cases present only in the base revision. */
  removed: TestCase[];
  /** Cases present only in the head revision. */
  added: TestCase[];
}

/** Collapses a test body to a comparable fingerprint. */
export function bodyFingerprint(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * The *shape* of a test, independent of its literal values: which expressions are
 * observed, which matchers are used, which production functions are called.
 *
 * Deliberately excludes expected values, because the whole point is to pair a test
 * with its weakened self — and weakening changes the matcher and the expected
 * value. Subjects and production calls are what stay stable.
 */
export interface CaseShape {
  subjects: Set<string>;
  calls: Set<string>;
  matchers: Set<string>;
  assertionCount: number;
}

export function caseShape(c: TestCase): CaseShape {
  return {
    subjects: new Set(c.assertions.map((a) => a.subjectKey).filter(Boolean)),
    calls: new Set(c.calls),
    matchers: new Set(c.assertions.map((a) => a.matcher)),
    assertionCount: c.assertions.length,
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Token-level similarity of two titles, for tie-breaking only. */
function titleSimilarity(a: string, b: string): number {
  const norm = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2),
    );
  return jaccard(norm(a), norm(b));
}

/**
 * Structural similarity between two test cases.
 *
 * Subjects are weighted highest because `expect(response.status)` surviving a
 * matcher change is exactly the signal `assertion-weakened` needs, and it is the
 * component least likely to coincide between genuinely different tests.
 */
export function structuralSimilarity(a: TestCase, b: TestCase): number {
  const sa = caseShape(a);
  const sb = caseShape(b);
  const subjects = jaccard(sa.subjects, sb.subjects);
  const calls = jaccard(sa.calls, sb.calls);
  const title = titleSimilarity(a.name, b.name);
  return subjects * 0.55 + calls * 0.3 + title * 0.15;
}

export interface PairingOptions {
  /** Minimum structural score to accept a heuristic pair. */
  minStructuralScore?: number;
  /** Required margin over the second-best candidate. */
  minMargin?: number;
}

const DEFAULTS: Required<PairingOptions> = {
  // Calibrated on the pairing benchmark in test/pairing.test.ts. Below 0.6 the
  // false-pair rate on parameterised suites becomes unacceptable.
  minStructuralScore: 0.6,
  minMargin: 0.15,
};

export function pairTestCases(
  before: readonly TestCase[],
  after: readonly TestCase[],
  options: PairingOptions = {},
): PairingResult {
  const opts = { ...DEFAULTS, ...options };
  const pairs: CasePair[] = [];
  const usedBefore = new Set<number>();
  const usedAfter = new Set<number>();

  const take = (bi: number, ai: number, basis: PairBasis, score: number): void => {
    pairs.push({ before: before[bi]!, after: after[ai]!, basis, score });
    usedBefore.add(bi);
    usedAfter.add(ai);
  };

  // ---- Layer 1: exact full title -----------------------------------------
  // Duplicate titles (parameterised suites reusing one template literal) are
  // consumed in order, which keeps the mapping stable and total.
  {
    const byTitle = new Map<string, number[]>();
    after.forEach((c, i) => {
      const list = byTitle.get(c.fullName) ?? [];
      list.push(i);
      byTitle.set(c.fullName, list);
    });
    before.forEach((c, bi) => {
      const queue = byTitle.get(c.fullName);
      if (!queue || queue.length === 0) return;
      const ai = queue.shift()!;
      take(bi, ai, "exact-title", 1);
    });
  }

  // ---- Layer 2: identical body, title changed ------------------------------
  // A pure rename. The body fingerprint is exact, so this is as certain as a
  // title match, and it closes the rename-plus-weaken hole only when the body did
  // not change — which is not the interesting case, but it keeps `test-removed`
  // and `test-disabled` honest.
  {
    const byBody = new Map<string, number[]>();
    after.forEach((c, i) => {
      if (usedAfter.has(i)) return;
      const fp = bodyFingerprint(c.body);
      if (fp.length < 20) return; // too small to be distinctive
      const list = byBody.get(fp) ?? [];
      list.push(i);
      byBody.set(fp, list);
    });
    before.forEach((c, bi) => {
      if (usedBefore.has(bi)) return;
      const fp = bodyFingerprint(c.body);
      const queue = byBody.get(fp);
      if (!queue || queue.length === 0) return;
      // Only when unambiguous: one candidate, not a family of identical bodies.
      if (queue.length > 1) return;
      const ai = queue[0]!;
      if (usedAfter.has(ai)) return;
      take(bi, ai, "identical-body", 0.98);
    });
  }

  // ---- Layer 3: same leaf title, describe path changed ---------------------
  {
    const byLeaf = new Map<string, number[]>();
    after.forEach((c, i) => {
      if (usedAfter.has(i)) return;
      const list = byLeaf.get(c.name) ?? [];
      list.push(i);
      byLeaf.set(c.name, list);
    });
    before.forEach((c, bi) => {
      if (usedBefore.has(bi)) return;
      const queue = byLeaf.get(c.name);
      if (!queue || queue.length !== 1) return;
      const ai = queue[0]!;
      if (usedAfter.has(ai)) return;
      take(bi, ai, "leaf-title", 0.9);
    });
  }

  // ---- Layer 4: structural similarity, unambiguous only --------------------
  // This is the layer that closes rename-plus-weaken. It is deliberately the most
  // constrained: a candidate must clear the score threshold *and* beat the
  // runner-up by a margin, in both directions (mutual best match).
  {
    const remainingBefore = before.map((c, i) => ({ c, i })).filter(({ i }) => !usedBefore.has(i));
    const remainingAfter = after.map((c, i) => ({ c, i })).filter(({ i }) => !usedAfter.has(i));

    const scores = new Map<string, number>();
    for (const b of remainingBefore) {
      for (const a of remainingAfter) {
        scores.set(`${b.i}:${a.i}`, structuralSimilarity(b.c, a.c));
      }
    }

    const ranked: Array<{ bi: number; ai: number; score: number }> = [];
    for (const b of remainingBefore) {
      const candidates = remainingAfter
        .map((a) => ({ ai: a.i, score: scores.get(`${b.i}:${a.i}`) ?? 0 }))
        .sort((x, y) => y.score - x.score);
      const best = candidates[0];
      if (!best || best.score < opts.minStructuralScore) continue;
      const runnerUp = candidates[1]?.score ?? 0;
      if (best.score - runnerUp < opts.minMargin) continue;

      // Mutual best: the chosen `after` case must also prefer this `before` case.
      const reverse = remainingBefore
        .map((x) => ({ bi: x.i, score: scores.get(`${x.i}:${best.ai}`) ?? 0 }))
        .sort((x, y) => y.score - x.score);
      if (reverse[0]?.bi !== b.i) continue;
      const reverseRunnerUp = reverse[1]?.score ?? 0;
      if ((reverse[0]?.score ?? 0) - reverseRunnerUp < opts.minMargin) continue;

      ranked.push({ bi: b.i, ai: best.ai, score: best.score });
    }

    ranked.sort((x, y) => y.score - x.score);
    for (const r of ranked) {
      if (usedBefore.has(r.bi) || usedAfter.has(r.ai)) continue;
      take(r.bi, r.ai, "structural", r.score);
    }
  }

  // ---- Layer 5: forced singleton ------------------------------------------
  // Exactly one unmatched case on each side, in a file small enough that the
  // mapping is not a guess.
  {
    const rb = before.map((_, i) => i).filter((i) => !usedBefore.has(i));
    const ra = after.map((_, i) => i).filter((i) => !usedAfter.has(i));
    if (rb.length === 1 && ra.length === 1 && before.length <= 3 && after.length <= 3) {
      const score = structuralSimilarity(before[rb[0]!]!, after[ra[0]!]!);
      if (score >= 0.35) take(rb[0]!, ra[0]!, "singleton", score);
    }
  }

  return {
    pairs,
    removed: before.filter((_, i) => !usedBefore.has(i)),
    added: after.filter((_, i) => !usedAfter.has(i)),
  };
}

/** Confidence multiplier applied to findings derived from each pairing basis. */
export function basisConfidenceFactor(basis: PairBasis): number {
  switch (basis) {
    case "exact-title":
      return 1;
    case "identical-body":
      return 1;
    case "leaf-title":
      return 0.95;
    case "structural":
      return 0.8;
    case "singleton":
      return 0.7;
  }
}
