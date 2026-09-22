/**
 * Links changed test files to the production files they exercise.
 *
 * This linkage is what makes cross-file rules possible. Two mechanisms, in
 * order of confidence:
 *
 *   1. Relative import resolution. If `auth.test.ts` imports `./auth`, the link
 *      is a fact, not a guess.
 *   2. Filename convention. `auth.test.ts` <-> `auth.ts` in the same or a
 *      sibling `src` directory. Used only when no import edge was found, and
 *      recorded as lower confidence by the rules that consume it.
 *
 * Deliberately not attempted: full module resolution with tsconfig path
 * aliases. It needs a program per revision and, in the corpora tested, added
 * nothing that convention matching did not already cover. Noted as a
 * limitation rather than hidden.
 */

import path from "node:path";
import type { ChangeSet, ImportRecord } from "./types.ts";

const CANDIDATE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Resolves a relative import specifier against the importing file's directory. */
export function resolveRelative(fromFile: string, specifier: string, known: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const baseDir = toPosix(path.posix.dirname(fromFile));
  const joined = toPosix(path.posix.normalize(path.posix.join(baseDir, specifier)));

  // Explicit extension, possibly a TS-style ".js" specifier pointing at ".ts".
  if (known.has(joined)) return joined;
  const withoutExt = joined.replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, "");
  for (const ext of CANDIDATE_EXTS) {
    if (known.has(withoutExt + ext)) return withoutExt + ext;
  }
  for (const ext of CANDIDATE_EXTS) {
    if (known.has(`${withoutExt}/index${ext}`)) return `${withoutExt}/index${ext}`;
  }
  return undefined;
}

/** Strips test naming conventions to get the base name under test. */
export function subjectNameOfTestFile(testPath: string): string {
  const base = path.posix.basename(toPosix(testPath));
  return base
    .replace(/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i, "")
    .replace(/^test_/, "")
    .replace(/_test\.py$/, "")
    .replace(/\.py$/, "");
}

export interface LinkOptions {
  /** All repo-relative paths that exist at head. Improves resolution accuracy. */
  knownPaths?: Iterable<string>;
}

export function buildTestToProductionMap(
  changeSet: ChangeSet,
  importsByTest: Map<string, ImportRecord[]>,
  opts: LinkOptions = {},
): Map<string, string[]> {
  const known = new Set<string>(opts.knownPaths ?? []);
  for (const f of changeSet.files) known.add(f.path);

  const productionPaths = changeSet.files.filter((f) => f.role === "production").map((f) => f.path);
  const result = new Map<string, string[]>();

  for (const file of changeSet.files) {
    if (file.role !== "test") continue;
    const links = new Set<string>();

    // (1) Import edges.
    for (const imp of importsByTest.get(file.path) ?? []) {
      const resolved = resolveRelative(file.path, imp.specifier, known);
      if (resolved) links.add(resolved);
    }

    // (2) Convention fallback, only against production files in this changeset.
    if (links.size === 0) {
      const subject = subjectNameOfTestFile(file.path).toLowerCase();
      if (subject.length >= 3) {
        for (const p of productionPaths) {
          const prodBase = path.posix.basename(p).replace(/\.(ts|tsx|js|jsx|mjs|cjs|py)$/i, "").toLowerCase();
          if (prodBase === subject) links.add(p);
        }
      }
    }

    result.set(file.path, [...links]);
  }

  return result;
}

/** Inverse index: production path -> changed test files that import it. */
export function invertLinks(map: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [testPath, prodPaths] of map) {
    for (const p of prodPaths) {
      const list = out.get(p) ?? [];
      list.push(testPath);
      out.set(p, list);
    }
  }
  return out;
}
