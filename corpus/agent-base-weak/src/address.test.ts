import { describe, expect, it } from "vitest";
import { normalisePostalCode, validateAddress } from "./address.ts";

const base = {
  line1: "Hauptstrasse 1",
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
};

describe("normalisePostalCode", () => {
  it("normalises a German code", () => {
    expect(normalisePostalCode(" 101 15 ", "DE")).toBeTruthy();
  });

  it("normalises a Dutch code", () => {
    expect(normalisePostalCode("1012  ab", "NL")).toBeDefined();
  });
});

describe("validateAddress", () => {
  it("accepts a valid address", () => {
    expect(validateAddress(base)).toBeTruthy();
  });

  it("rejects an empty street", () => {
    expect(() => validateAddress({ ...base, line1: "   " })).toThrow();
  });

  it("rejects an unsupported country", () => {
    expect(() => validateAddress({ ...base, country: "ZZ" })).toThrow();
  });

  it("rejects a malformed postal code", () => {
    expect(() => validateAddress({ ...base, postalCode: "123" })).toThrow();
  });
});
