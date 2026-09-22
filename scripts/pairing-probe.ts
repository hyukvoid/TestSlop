/**
 * Reports how the pairing layers behaved on a real repository diff.
 *
 * Used to verify, on independent-agent output rather than on fixtures, that renamed
 * and restructured tests are being matched across revisions.
 *
 * Usage: node --experimental-strip-types scripts/pairing-probe.ts <repo> [base]
 */

import path from "node:path";
import { collectChangeSet } from "../src/core/changeset.ts";
import { buildContext } from "../src/core/pipeline.ts";

const repo = process.argv[2];
if (!repo) {
  process.stderr.write("usage: pairing-probe.ts <repo> [base]\n");
  process.exit(2);
}
const base = process.argv[3] ?? "HEAD";

const cs = await collectChangeSet({ cwd: path.resolve(repo), base });
const ctx = await buildContext(cs, { python: false });

let renames = 0;
for (const [file, p] of ctx.pairings) {
  process.stdout.write(
    `${file}   pairs=${p.pairs.length} removed=${p.removed.length} added=${p.added.length}\n`,
  );
  const byBasis: Record<string, number> = {};
  for (const x of p.pairs) byBasis[x.basis] = (byBasis[x.basis] ?? 0) + 1;
  process.stdout.write(`   bases: ${JSON.stringify(byBasis)}\n`);
  for (const x of p.pairs) {
    if (x.before.fullName !== x.after.fullName) {
      renames += 1;
      process.stdout.write(
        `   matched across rename [${x.basis} ${x.score.toFixed(2)}]\n` +
          `     before: ${x.before.fullName}\n` +
          `     after : ${x.after.fullName}\n`,
      );
    }
  }
  for (const c of p.removed) process.stdout.write(`   unmatched removed: ${c.fullName}\n`);
  for (const c of p.added) process.stdout.write(`   unmatched added:   ${c.fullName}\n`);
}
process.stdout.write(`\ntotal pairs matched across a rename: ${renames}\n`);
