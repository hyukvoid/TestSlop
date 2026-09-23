import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectChangeSet } from "../src/core/changeset.ts";
import type { ChangeSet } from "../src/core/types.ts";
import { findEvilTwin, renderTwinReport } from "../src/mutation/twin.ts";
import { parseTestSummary } from "../src/mutation/test-runner.ts";

const nodeTestCommand = "node --test";
const invalidTests = `import test from "node:test";
import assert from "node:assert/strict";
import { reserve } from "../src/subject.js";

test("rejects negative quantities", () => assert.throws(() => reserve(-1), RangeError));
test("accepts a positive quantity", () => assert.deepEqual(reserve(2), { accepted: true }));
`;
const zeroTest = `test("rejects zero", () => assert.throws(() => reserve(0), RangeError));
`;
const oneTest = `test("accepts one", () => assert.deepEqual(reserve(1), { accepted: true }));
`;

function reserveSource(operator = "<=") {
  return `export function reserve(quantity) {
  if (quantity ${operator} 0) throw new RangeError("quantity must be positive");
  return { accepted: true };
}
`;
}

interface FixtureOptions { beforeSource: string; afterSource: string; beforeTest: string; afterTest: string; }
interface Fixture { repo: string; changeSet: ChangeSet; }

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

async function makeChangeSet({ beforeSource, afterSource, beforeTest, afterTest }: FixtureOptions): Promise<Fixture> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "testslop-twin-test-"));
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "test"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "twin-test-fixture", private: true, type: "module" }));
  await writeFile(path.join(repo, "src", "subject.js"), beforeSource);
  await writeFile(path.join(repo, "test", "subject.test.js"), beforeTest);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "TestSlop regression"]);
  git(repo, ["config", "user.email", "testslop@example.invalid"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);
  await writeFile(path.join(repo, "src", "subject.js"), afterSource);
  await writeFile(path.join(repo, "test", "subject.test.js"), afterTest);
  return { repo, changeSet: await collectChangeSet({ cwd: repo, base: "HEAD" }) };
}

async function withFixture<T>(options: FixtureOptions, action: (fixture: Fixture) => Promise<T>): Promise<T> {
  const fixture = await makeChangeSet(options);
  try {
    return await action(fixture);
  } finally {
    await rm(fixture.repo, { recursive: true, force: true });
  }
}

describe("Evil Twin", () => {
  it("shows one surviving boundary Twin, counts, and a concrete witness", async () => {
    await withFixture({
      beforeSource: reserveSource("<"),
      afterSource: reserveSource("<="),
      beforeTest: invalidTests,
      afterTest: invalidTests + zeroTest,
    }, async ({ repo, changeSet }) => {
      const sourcePath = path.join(repo, "src", "subject.js");
      const beforeHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
      const report = await findEvilTwin(changeSet, { testCommand: nodeTestCommand });
      expect(report.status).toBe("found");
      if (report.status !== "found") return;
      expect(report.evidence.original).toContain("quantity <= 0");
      expect(report.evidence.twin).toContain("quantity <= 1");
      expect(report.evidence.witness).toBe("quantity = 1");
      expect(report.evidence.originalTests).toEqual({ passed: 3, total: 3 });
      expect(report.evidence.twinTests).toEqual({ passed: 3, total: 3 });
      const output = renderTwinReport(report);
      expect(output).toContain("Your tests accept BOTH implementations.");
      expect(output).toContain("Missing witness:\n  quantity = 1");
      expect(output.match(/Evil Twin:\n/g)).toHaveLength(1);
      expect(output).not.toMatch(/\u001b\[[0-9;]*m/);
      const afterHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
      expect(afterHash).toBe(beforeHash);
    });
  });

  it("does not report a Twin that the tests kill", async () => {
    await withFixture({
      beforeSource: reserveSource("<"),
      afterSource: reserveSource("<="),
      beforeTest: invalidTests,
      afterTest: invalidTests + zeroTest + oneTest,
    }, async ({ changeSet }) => {
      const report = await findEvilTwin(changeSet, { testCommand: nodeTestCommand });
      expect(report.status).toBe("none");
      expect(renderTwinReport(report)).toContain("No credible Evil Twin found");
    });
  });

  it("reports no Twin when the changed lines have no supported boundary", async () => {
    await withFixture({
      beforeSource: `export function normalize(value) { return value.trim(); }\n`,
      afterSource: `export function normalize(value) { return value.trim().toLowerCase(); }\n`,
      beforeTest: `import test from "node:test"; import assert from "node:assert/strict"; import { normalize } from "../src/subject.js";\ntest("normalizes", () => assert.equal(normalize(" A "), "A"));\n`,
      afterTest: `import test from "node:test"; import assert from "node:assert/strict"; import { normalize } from "../src/subject.js";\ntest("normalizes", () => assert.equal(normalize(" A "), "a"));\n`,
    }, async ({ changeSet }) => {
      const report = await findEvilTwin(changeSet, { testCommand: nodeTestCommand });
      expect(report.status).toBe("none");
      expect(renderTwinReport(report)).toContain("No Twin found does not mean the code is verified correct.");
    });
  });

  it("still prints one Twin when several credible survivors exist", async () => {
    const source = (quantityOperator: string, limitOperator: string) => `export function reserve(quantity, limit) {
  if (quantity ${quantityOperator} 0) throw new RangeError("quantity must be positive");
  if (quantity ${limitOperator} limit) throw new RangeError("over limit");
  return { accepted: true };
}
`;
    const baseTests = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { reserve } from "../src/subject.js";\ntest("rejects above the limit", () => assert.throws(() => reserve(11, 10), RangeError));\ntest("accepts an ordinary quantity", () => assert.deepEqual(reserve(2, 10), { accepted: true }));\n`;
    await withFixture({
      beforeSource: source("<", ">="),
      afterSource: source("<=", ">"),
      beforeTest: baseTests,
      afterTest: baseTests + zeroTest,
    }, async ({ changeSet }) => {
      const report = await findEvilTwin(changeSet, { testCommand: nodeTestCommand });
      expect(report.status).toBe("found");
      if (report.status !== "found") return;
      expect(report.evidence.additionalSurvivors).toBeGreaterThan(0);
      expect(renderTwinReport(report).match(/Evil Twin:\n/g)).toHaveLength(1);
    });
  });
});
describe("test summary parsing", () => {
  it("reads Vitest, Jest, and node:test passing counts", () => {
    expect(parseTestSummary("Tests  5 passed (5)")).toEqual({ passed: 5, total: 5 });
    expect(parseTestSummary("Tests:       8 passed, 8 total")).toEqual({ passed: 8, total: 8 });
    expect(parseTestSummary("ℹ tests 3\nℹ pass 3\nℹ fail 0")).toEqual({ passed: 3, total: 3 });
    expect(parseTestSummary("no recognized summary")).toBeUndefined();
  });
});
