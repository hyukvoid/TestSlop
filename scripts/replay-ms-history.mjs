import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectChangeSet } from "../dist/core/changeset.js";
import { findEvilTwin, renderTwinReport } from "../dist/mutation/twin.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotRoot = path.join(projectRoot, "examples", "historical", "ms");
const repo = await mkdtemp(path.join(os.tmpdir(), "testslop-ms-history-"));
const names = ["index.ts", "format.test.ts", "index.test.ts", "parse.test.ts", "parse-strict.test.ts"];
const revisions = ["parent", "month-support"];

function git(args) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

async function populate(revision) {
  await mkdir(path.join(repo, "src"), { recursive: true });
  for (const name of names) {
    const source = await readFile(path.join(snapshotRoot, revision, "src", name), "utf8");
    // This temporary harness uses the root's locked Vitest dependency. Only the test
    // runner import changes; the archived source and assertions remain untouched.
    const adapted = name.endsWith(".test.ts")
      ? source.replace("from '@jest/globals'", "from 'vitest'")
      : source;
    await writeFile(path.join(repo, "src", name), adapted, "utf8");
  }
}

try {
  await writeFile(path.join(repo, "package.json"), JSON.stringify({
    name: "ms-historical-replay",
    private: true,
    type: "module",
    devDependencies: { vitest: "3.2.4" },
  }, null, 2));
  await populate(revisions[0]);
  git(["init", "-q", "-b", "base"]);
  git(["config", "user.name", "TestSlop history replay"]);
  git(["config", "user.email", "history@example.invalid"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "ms parent 0d5ab182"]);

  await populate(revisions[1]);
  const changeSet = await collectChangeSet({ cwd: repo, base: "HEAD" });
  const report = await findEvilTwin(changeSet, {
    budget: 12,
    modulesFrom: path.join(projectRoot, "node_modules"),
  });
  process.stdout.write(renderTwinReport(report));
  if (report.status !== "found") throw new Error("The historical ms replay no longer produces its documented Twin");
  if (report.evidence.witness !== "ms = 31,557,600,000 ms") {
    throw new Error(`Unexpected historical witness: ${report.evidence.witness}`);
  }
} finally {
  await rm(repo, { recursive: true, force: true });
}
