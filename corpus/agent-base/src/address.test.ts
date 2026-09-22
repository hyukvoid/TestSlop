import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.ts";
import { normalisePostalCode, validateAddress } from "./address.ts";

const base = {
  line1: "Hauptstrasse 1",
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
};

describe("normalisePostalCode", () => {
  it("strips spaces for numeric countries", () => {
    expect(normalisePostalCode(" 101 15 ", "DE")).toBe("10115");
  });

  it("keeps a single space for NL codes", () => {
    expect(normalisePostalCode("1012  ab", "NL")).toBe("1012 AB");
  });
});

describe("validateAddress", () => {
  it("accepts a valid German address", () => {
    expect(validateAddress(base)).toEqual(base);
  });

  it("rejects an empty street", () => {
    expect(() => validateAddress({ ...base, line1: "   " })).toThrow(ValidationError);
  });

  it("rejects an unsupported country", () => {
    expect(() => validateAddress({ ...base, country: "ZZ" })).toThrow("unsupported country ZZ");
  });

  it("rejects a malformed postal code", () => {
    expect(() => validateAddress({ ...base, postalCode: "123" })).toThrow("invalid postal code for DE");
  });
});
