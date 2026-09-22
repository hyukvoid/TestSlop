/**
 * Analysis-coverage tests.
 *
 * The property being protected: a scan that analysed nothing must never be
 * presentable as a scan that found nothing. POC-00 shipped that bug (ky: 256 test
 * cases parsed, zero assertions analysed, reported as clean).
 */

import { describe, expect, it } from "vitest";
import { syntheticChangeSet } from "../src/core/changeset.ts";
import { analyse } from "../src/core/pipeline.ts";
import { renderReport } from "../src/report/human.ts";
import { toJsonReport } from "../src/report/json.ts";

const AVA_TEST = `import test from "ava";
import { add } from "./subject.js";

test("adds", (t) => {
  t.is(add(1, 2), 3);
});

test("adds more", (t) => {
  t.is(add(2, 2), 4);
});
`;

const VITEST_TEST = `import { describe, expect, it } from "vitest";
import { add } from "./subject.ts";

describe("add", () => {
  it("adds", () => {
    expect(add(1, 2)).toBe(3);
  });
});
`;

async function scan(files: Array<{ path: string; before?: string; after?: string }>) {
  return analyse(syntheticChangeSet(files), { python: false });
}

describe("coverage on a supported framework", () => {
  it("reports complete coverage and counts assertions", async () => {
    const result = await scan([{ path: "src/subject.test.ts", before: VITEST_TEST, after: VITEST_TEST }]);
    const cov = result.summary.coverage;
    expect(cov.complete).toBe(true);
    expect(cov.testsDiscovered).toBe(1);
    expect(cov.testsAnalysed).toBe(1);
    expect(cov.assertionsRecognised).toBe(1);
    expect(cov.frameworks).toEqual(["vitest"]);
  });
});

describe("coverage on an unsupported assertion API", () => {
  it("marks the scan incomplete and names the library", async () => {
    const result = await scan([
      { path: "test/x.test.js", before: AVA_TEST, after: AVA_TEST.replace("t.is(add(1, 2), 3)", "t.truthy(add(1, 2))") },
    ]);
    const cov = result.summary.coverage;
    expect(cov.complete).toBe(false);
    expect(cov.testsDiscovered).toBe(2);
    expect(cov.testsAnalysed).toBe(0);
    expect(cov.assertionsRecognised).toBe(0);
    expect(cov.unanalysedFiles).toHaveLength(1);
    expect(cov.unanalysedFiles[0]!.problem).toMatch(/ava/);
  });

  it("REGRESSION: the human report must not say 'no problems found'", async () => {
    const result = await scan([
      { path: "test/x.test.js", before: AVA_TEST, after: AVA_TEST.replace("t.is(add(1, 2), 3)", "t.truthy(add(1, 2))") },
    ]);
    expect(result.findings).toHaveLength(0);
    const text = renderReport(result);
    expect(text).not.toMatch(/No review-worthy changes/);
    expect(text).toMatch(/oracle analysis did not run/i);
    expect(text).toMatch(/Tests discovered\s+2/);
    expect(text).toMatch(/Assertions recognised\s+0/);
  });

  it("flags analysisComplete=false in the JSON report", async () => {
    const result = await scan([
      { path: "test/x.test.js", before: AVA_TEST, after: AVA_TEST.replace("t.is(add(1, 2), 3)", "t.truthy(add(1, 2))") },
    ]);
    const json = toJsonReport(result);
    expect(json.analysisComplete).toBe(false);
    expect(json.findings).toHaveLength(0);
  });

  it("keeps analysisComplete=true for a fully analysed scan", async () => {
    const result = await scan([{ path: "src/subject.test.ts", before: VITEST_TEST, after: VITEST_TEST }]);
    expect(toJsonReport(result).analysisComplete).toBe(true);
  });
});

describe("coverage with chai", () => {
  it("counts chai assertions as analysed", async () => {
    const chai = `import { expect } from "chai";
import { add } from "./subject.js";

describe("add", () => {
  it("adds", () => {
    expect(add(1, 2)).to.equal(3);
  });

  it("is positive", () => {
    expect(add(1, 2)).to.be.above(0);
  });
});
`;
    const result = await scan([{ path: "src/subject.test.js", before: chai, after: chai }]);
    const cov = result.summary.coverage;
    expect(cov.complete).toBe(true);
    expect(cov.assertionsRecognised).toBe(2);
    expect(cov.frameworks).toEqual(["mocha-chai"]);
  });
});

describe("coverage with a throwing-query oracle", () => {
  it("counts implicit assertions so a testing-library test is not reported as unanalysed", async () => {
    const src = `import { describe, it } from "vitest";
import { render } from "@testing-library/react";
import { Widget } from "./subject.ts";

describe("Widget", () => {
  it("renders the label", () => {
    const { getByText } = render(Widget());
    getByText("hello");
  });
});
`;
    const result = await scan([{ path: "src/subject.test.ts", before: src, after: src }]);
    const cov = result.summary.coverage;
    expect(cov.complete).toBe(true);
    expect(cov.assertionsRecognised).toBe(0);
    expect(cov.files[0]!.implicitAssertions).toBeGreaterThan(0);
  });
});
