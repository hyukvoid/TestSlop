/**
 * chai adapter tests.
 *
 * Two things are being verified:
 *
 *   1. every chai form maps onto the correct class in the shared strength lattice
 *   2. the *rules* work on chai files without modification
 *
 * The second is the architectural claim. If a rule needed a chai-specific branch,
 * the adapter boundary would have failed.
 */

import { describe, expect, it } from "vitest";
import { parseTestFile } from "../src/adapters/ts/parse-test.ts";
import { toCanonicalMatcher } from "../src/adapters/ts/chai.ts";
import { syntheticChangeSet } from "../src/core/changeset.ts";
import { analyse } from "../src/core/pipeline.ts";
import type { AssertionArg, Finding, StrengthClass } from "../src/core/types.ts";

const HEAD = `import { expect } from "chai";
import { calculateTax, authenticate } from "./subject.js";
`;

function parse(body: string, head = HEAD) {
  const src = `${head}
describe("subject", () => {
  it("does the thing", () => {
${body}
  });
});
`;
  return parseTestFile("src/subject.test.js", src);
}

function strengthOf(body: string): StrengthClass | undefined {
  const model = parse(body);
  return model.cases[0]?.assertions[0]?.strength;
}

function firstAssertion(body: string) {
  return parse(body).cases[0]?.assertions[0];
}

// ---------------------------------------------------------------------------

describe("chai detection", () => {
  it("recognises the framework from the import", () => {
    expect(parse("expect(1).to.equal(1);").framework).toBe("mocha-chai");
  });

  it("recognises chai installed as a global, with no import", () => {
    const model = parse("expect(calculateTax({})).to.equal(1);", 'import { calculateTax } from "./subject.js";\n');
    expect(model.framework).toBe("mocha-chai");
  });

  it("no longer reports chai as an unsupported assertion library", () => {
    const model = parse("expect(calculateTax({ subtotal: 100 })).to.equal(19);");
    expect(model.problems.join(" ")).not.toMatch(/unsupported/i);
    expect(model.cases[0]!.assertions).toHaveLength(1);
  });
});

describe("chai: call-terminated chains", () => {
  it.each<[string, StrengthClass]>([
    ["expect(calculateTax({})).to.equal(120);", "EXACT"],
    ["expect(calculateTax({})).to.eql({ a: 1 });", "EXACT"],
    ["expect(calculateTax({})).to.deep.equal({ a: 1 });", "EXACT"],
    ["expect(calculateTax({})).to.be.above(0);", "CONSTRAINED"],
    ["expect(calculateTax({})).to.be.at.least(10);", "CONSTRAINED"],
    ["expect(calculateTax({})).to.be.closeTo(1.5, 0.1);", "CONSTRAINED"],
    ["expect(calculateTax({})).to.match(/^\\d+$/);", "CONSTRAINED"],
    ["expect(calculateTax({})).to.be.a('string');", "TYPE_ONLY"],
    ["expect(calculateTax({})).to.be.an.instanceof(Error);", "TYPE_ONLY"],
    ["expect(calculateTax({})).to.include('x');", "STRUCTURAL"],
    ["expect(calculateTax({})).to.have.lengthOf(3);", "STRUCTURAL"],
    ["expect(calculateTax({})).to.have.property('a', 1);", "STRUCTURAL"],
  ])("classifies %s as %s", (src, expected) => {
    expect(strengthOf(`    ${src}`)).toBe(expected);
  });

  it("treats have.property without a value as an existence check", () => {
    expect(strengthOf("    expect(calculateTax({})).to.have.property('a');")).toBe("EXISTENCE");
  });
});

describe("chai: property-terminated chains", () => {
  it.each<[string, StrengthClass]>([
    ["expect(calculateTax({})).to.be.true;", "EXACT"],
    ["expect(calculateTax({})).to.be.false;", "EXACT"],
    ["expect(calculateTax({})).to.be.null;", "EXACT"],
    ["expect(calculateTax({})).to.be.undefined;", "EXACT"],
    ["expect(calculateTax({})).to.be.NaN;", "EXACT"],
    ["expect(calculateTax({})).to.exist;", "EXISTENCE"],
    ["expect(calculateTax({})).to.be.ok;", "EXISTENCE"],
    ["expect(calculateTax({})).to.be.empty;", "STRUCTURAL"],
  ])("classifies %s as %s", (src, expected) => {
    expect(strengthOf(`    ${src}`)).toBe(expected);
  });

  it("is why chai needs its own extractor: there is no call expression", () => {
    // `.to.be.true` asserts through a getter. A matcher-call-based extractor sees
    // nothing at all here.
    const a = firstAssertion("    expect(authenticate('x').ok).to.be.true;");
    expect(a).toBeDefined();
    expect(a!.subject).toBe("authenticate('x').ok");
  });
});

describe("chai: should form", () => {
  it("handles x.should.equal(y)", () => {
    const a = firstAssertion("    calculateTax({}).should.equal(120);");
    expect(a).toBeDefined();
    expect(a!.strength).toBe<StrengthClass>("EXACT");
    expect(a!.subject).toBe("calculateTax({})");
  });

  it("handles a negated should chain", () => {
    const a = firstAssertion("    calculateTax({}).should.not.be.ok;");
    expect(a).toBeDefined();
    expect(a!.negated).toBe(true);
  });
});

describe("chai: negation follows the same per-matcher rules as Jest", () => {
  it("makes not.equal(literal) vacuous", () => {
    expect(strengthOf("    expect(calculateTax({})).to.not.equal(3);")).toBe("VACUOUS");
  });

  it("keeps not.equal(reference) as a precise non-identity claim", () => {
    expect(strengthOf("    expect(calculateTax({})).to.not.equal(original);")).toBe("CONSTRAINED");
  });

  it("treats not.exist as pinning one value", () => {
    // `.to.not.exist` is "is null or undefined".
    expect(strengthOf("    expect(calculateTax({})).to.not.exist;")).toBe("EXACT");
  });

  it("treats not.have.property as a precise absence claim", () => {
    expect(strengthOf("    expect(calculateTax({})).to.not.have.property('cause');")).toBe("STRUCTURAL");
  });
});

describe("chai: error assertions", () => {
  it.each<[string, StrengthClass]>([
    ["expect(() => calculateTax({})).to.throw();", "EXISTENCE"],
    ["expect(() => calculateTax({})).to.throw(Error);", "TYPE_ONLY"],
    ["expect(() => calculateTax({})).to.throw(ValidationError);", "TYPE_ONLY"],
    ["expect(() => calculateTax({})).to.throw('bad input');", "CONSTRAINED"],
  ])("classifies %s as %s", (src, expected) => {
    expect(strengthOf(`    ${src}`)).toBe(expected);
  });

  it("records the error aspect so exception-broadened applies", () => {
    expect(firstAssertion("    expect(() => calculateTax({})).to.throw();")!.aspect).toBe("error");
  });
});

describe("chai: sinon-chai interactions", () => {
  it("classifies have.been.called as an existence-level interaction", () => {
    const a = firstAssertion("    expect(spy).to.have.been.called;");
    expect(a!.aspect).toBe("interaction");
    expect(a!.strength).toBe<StrengthClass>("EXISTENCE");
  });

  it("classifies not.have.been.called as pinning the count to zero", () => {
    expect(strengthOf("    expect(spy).to.not.have.been.called;")).toBe("EXACT");
  });

  it("classifies calledWith(literals) as structural", () => {
    expect(strengthOf("    expect(spy).to.have.been.calledWith('a', 1);")).toBe("STRUCTURAL");
  });

  it("classifies calledOnce as a call count", () => {
    expect(strengthOf("    expect(spy).to.have.been.calledOnce;")).toBe("CONSTRAINED");
  });
});

describe("toCanonicalMatcher", () => {
  it("returns undefined for an unknown terminal so unknown plugins are ignored", () => {
    expect(toCanonicalMatcher("someExoticPluginAssertion", { negated: false, deep: false }, [])).toBeUndefined();
  });

  it("synthesises the expected value for property terminals", () => {
    const c = toCanonicalMatcher("true", { negated: false, deep: false }, []);
    expect(c).toEqual({ matcher: "toBe", negated: false, syntheticArgs: [{ raw: "true", kind: "boolean" }] });
  });

  it("chooses toBe vs toEqual from the deep flag", () => {
    expect(toCanonicalMatcher("equal", { negated: false, deep: false }, [])!.matcher).toBe("toBe");
    expect(toCanonicalMatcher("equal", { negated: false, deep: true }, [])!.matcher).toBe("toEqual");
  });
});

// ---------------------------------------------------------------------------
// The architectural claim: rules work unmodified on chai
// ---------------------------------------------------------------------------

async function scan(files: Array<{ path: string; before?: string; after?: string }>): Promise<Finding[]> {
  const result = await analyse(syntheticChangeSet(files), { python: false });
  return result.findings;
}

const ruleIds = (f: Finding[]): string[] => [...new Set(f.map((x) => x.ruleId))];

describe("rules apply to chai with no rule changes", () => {
  const wrap = (assertion: string, name = "rejects a missing token"): string =>
    `import { expect } from "chai";
import { authenticate } from "./subject.js";

describe("authenticate", () => {
  it("${name}", () => {
    const response = authenticate(undefined);
${assertion}
  });
});
`;

  it("assertion-weakened fires on a chai file", () => {
    return scan([
      {
        path: "src/subject.test.js",
        before: wrap("    expect(response.status).to.equal(401);"),
        after: wrap("    expect(response.status).to.exist;"),
      },
    ]).then((findings) => {
      const f = findings.find((x) => x.ruleId === "assertion-weakened");
      expect(f).toBeDefined();
      expect(f!.message).toContain("EXACT");
      expect(f!.message).toContain("EXISTENCE");
    });
  });

  it("assertion-weakened fires when a chai chain collapses to a property terminal", () => {
    return scan([
      {
        path: "src/subject.test.js",
        before: wrap("    expect(response.status).to.equal(401);"),
        after: wrap("    expect(response.status).to.be.ok;"),
      },
    ]).then((findings) => {
      expect(ruleIds(findings)).toContain("assertion-weakened");
    });
  });

  it("exception-broadened fires on a chai file", () => {
    return scan([
      {
        path: "src/subject.test.js",
        before: wrap("    expect(() => authenticate()).to.throw(ValidationError);"),
        after: wrap("    expect(() => authenticate()).to.throw();"),
      },
    ]).then((findings) => {
      expect(ruleIds(findings)).toContain("exception-broadened");
    });
  });

  it("stays silent when a chai assertion is strengthened", () => {
    return scan([
      {
        path: "src/subject.test.js",
        before: wrap("    expect(response.status).to.exist;"),
        after: wrap("    expect(response.status).to.equal(401);"),
      },
    ]).then((findings) => {
      expect(ruleIds(findings)).not.toContain("assertion-weakened");
    });
  });

  it("expected-chasing-implementation works across a chai test and its production file", () => {
    const testBefore = `import { expect } from "chai";
import { calculateTax } from "./tax.js";

describe("calculateTax", () => {
  it("applies the standard rate", () => {
    expect(calculateTax({ subtotal: 1000 })).to.equal(120);
  });
});
`;
    return scan([
      { path: "src/tax.test.js", before: testBefore, after: testBefore.replace("120", "100") },
      {
        path: "src/tax.js",
        before: "export function calculateTax(o) {\n  return o.subtotal * 0.12;\n}\n",
        after: "export function calculateTax(o) {\n  return o.subtotal * 0.1;\n}\n",
      },
    ]).then((findings) => {
      const f = findings.find((x) => x.ruleId === "expected-chasing-implementation");
      expect(f).toBeDefined();
      expect(f!.evidence.some((e) => e.label === "Derivation")).toBe(true);
    });
  });
});
