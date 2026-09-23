import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "dist", "cli.js");
const repo = await mkdtemp(path.join(os.tmpdir(), "testslop-hero-"));

const baseSource = `export function reserve(quantity) {
  if (quantity < 0) throw new RangeError("quantity must be positive");
  return { accepted: true };
}
`;
const currentSource = `export function reserve(quantity) {
  if (quantity <= 0) throw new RangeError("quantity must be positive");
  return { accepted: true };
}
`;
const baseTests = `import test from "node:test";
import assert from "node:assert/strict";
import { reserve } from "../src/reservation.js";

test("rejects a negative quantity", () => {
  assert.throws(() => reserve(-1), RangeError);
});

test("accepts a positive quantity", () => {
  assert.deepEqual(reserve(2), { accepted: true });
});
`;
const currentTests = `${baseTests}
test("rejects zero", () => {
  assert.throws(() => reserve(0), RangeError);
});
`;

function git(args) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

try {
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "test"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "evil-twin-demo", private: true, type: "module" }, null, 2));
  await writeFile(path.join(repo, "src", "reservation.js"), baseSource);
  await writeFile(path.join(repo, "test", "reservation.test.js"), baseTests);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "TestSlop demo"]);
  git(["config", "user.email", "demo@example.invalid"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);

  await writeFile(path.join(repo, "src", "reservation.js"), currentSource);
  await writeFile(path.join(repo, "test", "reservation.test.js"), currentTests);
  const before = await readFile(path.join(repo, "src", "reservation.js"), "utf8");

  process.stdout.write("Agent (demo): implementation complete; tests passed.\n\n$ testslop twin\n");
  const run = spawnSync(process.execPath, [
    cliPath,
    "twin",
    "--cwd",
    repo,
    "--test-command",
    "node --test",
  ], { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Twin demo exited with status ${run.status}`);

  const after = await readFile(path.join(repo, "src", "reservation.js"), "utf8");
  if (after !== before) throw new Error("Twin demo changed the source file outside its scratch copy");
} finally {
  await rm(repo, { recursive: true, force: true });
}
