/**
 * Positive control for the agent benchmark harness.
 *
 * The benchmark reported zero findings on every completed task. That is either a
 * real result about agent quality or a harness defect, and the two are
 * indistinguishable from the outside. This script proves the harness can see a
 * finding at all, by injecting known-degraded edits into a materialised task
 * repository and running the *same* analysis path the benchmark uses.
 *
 * If any of these controls fails to fire, the benchmark's zeros are meaningless.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { collectChangeSet } from "../src/core/changeset.ts";
import { analyse } from "../src/core/pipeline.ts";
import { listFilesAtRef } from "../src/core/git.ts";
import { AGENT_TASKS } from "../corpus/agent-tasks/index.ts";
import { runTask } from "./agent-bench.ts";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

interface Control {
  name: string;
  /** Edits applied to the materialised repo, keyed by repo-relative path. */
  edit: (read: (p: string) => Promise<string>) => Promise<Record<string, string>>;
  expectRule: string;
}

const CONTROLS: Control[] = [
  {
    name: "assertion weakened in money.test.ts",
    expectRule: "assertion-weakened",
    edit: async (read) => {
      const src = await read("src/money.test.ts");
      return {
        "src/money.test.ts": src.replace(
          'expect(format(money(123456))).toBe("1234.56 EUR");',
          "expect(format(money(123456))).toBeDefined();",
        ),
      };
    },
  },
  {
    name: "test switched to skip",
    expectRule: "test-disabled",
    edit: async (read) => {
      const src = await read("src/orders.test.ts");
      return {
        "src/orders.test.ts": src.replace(
          'it("rejects an illegal move"',
          'it.skip("rejects an illegal move"',
        ),
      };
    },
  },
  {
    name: "expected value chases the implementation constant",
    expectRule: "expected-chasing-implementation",
    edit: async (read) => {
      const prod = await read("src/pricing.ts");
      const test = await read("src/pricing.test.ts");
      return {
        // 0.19 -> 0.20 and the pinned tax total scaled by exactly that ratio.
        "src/pricing.ts": prod.replace("STANDARD_TAX_RATE = 0.19", "STANDARD_TAX_RATE = 0.2"),
        "src/pricing.test.ts": test
          .replace("expect(taxRateFor(\"TOOL-9\")).toBe(0.19);", "expect(taxRateFor(\"TOOL-9\")).toBe(0.2);")
          .replace("expect(result.tax.cents).toBe(380);", "expect(result.tax.cents).toBe(400);")
          .replace("expect(result.total.cents).toBe(2380);", "expect(result.total.cents).toBe(2400);"),
      };
    },
  },
  {
    name: "all assertions removed from a surviving test",
    expectRule: "assertion-removed",
    edit: async (read) => {
      const src = await read("src/inventory.test.ts");
      return {
        "src/inventory.test.ts": src.replace(
          "    inv.receive(\"TOOL-1\", 10);\n    inv.reserve(\"TOOL-1\", 4);\n    expect(inv.available(\"TOOL-1\")).toBe(6);",
          "    inv.receive(\"TOOL-1\", 10);\n    inv.reserve(\"TOOL-1\", 4);",
        ),
      };
    },
  },
  {
    name: "renamed AND weakened (the POC-01 pairing case)",
    expectRule: "assertion-weakened",
    edit: async (read) => {
      const src = await read("src/address.test.ts");
      return {
        "src/address.test.ts": src
          .replace('it("accepts a valid German address"', 'it("handles a German address"')
          .replace("expect(validateAddress(base)).toEqual(base);", "expect(validateAddress(base)).toBeTruthy();"),
      };
    },
  },
];

async function main(): Promise<void> {
  // Materialise a repo using the same path the benchmark uses, but without running
  // the agent, so the only difference is who made the edits.
  const task = AGENT_TASKS.find((t) => t.id === "T06-more-postal-code-countries")!;
  const repo = path.join(ROOT, "work", "agentbench-control");

  const { mkdir, rm, cp } = await import("node:fs/promises");
  const base = path.join(ROOT, "corpus", "agent-base");

  const results: Array<{ name: string; expectRule: string; fired: boolean; rules: string[] }> = [];

  for (const control of CONTROLS) {
    await rm(repo, { recursive: true, force: true });
    await mkdir(repo, { recursive: true });
    await cp(base, repo, { recursive: true });
    await rm(path.join(repo, "README.md"), { force: true });

    const gitId = ["-c", "user.name=Control", "-c", "user.email=c@x.local", "-c", "core.autocrlf=false"];
    await exec("git", [...gitId, "init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
    await exec("git", [...gitId, "add", "-A"], { cwd: repo, windowsHide: true });
    await exec("git", [...gitId, "commit", "-q", "-m", "base"], { cwd: repo, windowsHide: true });

    const read = (p: string): Promise<string> => readFile(path.join(repo, p), "utf8");
    const edits = await control.edit(read);
    for (const [rel, content] of Object.entries(edits)) {
      await writeFile(path.join(repo, rel), content, "utf8");
    }

    const changeSet = await collectChangeSet({ cwd: repo, base: "HEAD" });
    const knownPaths = await listFilesAtRef(repo, "HEAD").catch(() => [] as string[]);
    const result = await analyse(changeSet, { knownPaths, python: false });
    const rules = [...new Set(result.findings.map((f) => f.ruleId))];

    results.push({
      name: control.name,
      expectRule: control.expectRule,
      fired: rules.includes(control.expectRule),
      rules,
    });
  }

  const out: string[] = [""];
  out.push("Agent benchmark harness — positive control");
  out.push("=".repeat(80));
  out.push("Injecting known-degraded edits into a materialised task repository and");
  out.push("analysing through the same code path the benchmark uses.");
  out.push("");
  let allFired = true;
  for (const r of results) {
    out.push(`  ${r.fired ? "FIRED " : "SILENT"}  ${r.expectRule.padEnd(34)} ${r.name}`);
    if (!r.fired) {
      allFired = false;
      out.push(`          reported instead: ${r.rules.join(", ") || "nothing"}`);
    }
  }
  out.push("");
  out.push(
    allFired
      ? "All controls fired. The benchmark's zero-finding results are a property of the"
      : "AT LEAST ONE CONTROL FAILED. The benchmark's zero-finding results cannot be",
  );
  out.push(allFired ? "agent's output, not of the harness." : "trusted until this is fixed.");
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
  process.exit(allFired ? 0 : 1);
}

await main();
