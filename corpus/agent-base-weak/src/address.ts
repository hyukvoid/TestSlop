import { ValidationError } from "./errors.ts";

export interface Address {
  line1: string;
  line2?: string;
  postalCode: string;
  city: string;
  country: string;
}

const POSTAL_PATTERNS: Record<string, RegExp> = {
  DE: /^\d{5}$/,
  NL: /^\d{4}\s?[A-Z]{2}$/,
  FR: /^\d{5}$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/,
  US: /^\d{5}(-\d{4})?$/,
};

export function supportedCountries(): string[] {
  return Object.keys(POSTAL_PATTERNS).sort();
}

export function normalisePostalCode(raw: string, country: string): string {
  const compact = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (country === "NL" || country === "GB") return compact;
  return compact.replace(/\s/g, "");
}

export function normaliseAddress(input: Address): Address {
  const country = input.country.trim().toUpperCase();
  const normalised: Address = {
    line1: input.line1.trim().replace(/\s+/g, " "),
    postalCode: normalisePostalCode(input.postalCode, country),
    city: input.city.trim().replace(/\s+/g, " "),
    country,
  };
  const line2 = input.line2?.trim().replace(/\s+/g, " ");
  if (line2) normalised.line2 = line2;
  return normalised;
}

export function validateAddress(input: Address): Address {
  const address = normaliseAddress(input);

  if (address.line1.length === 0) {
    throw new ValidationError("line1", "street address is required");
  }
  if (address.city.length === 0) {
    throw new ValidationError("city", "city is required");
  }
  const pattern = POSTAL_PATTERNS[address.country];
  if (!pattern) {
    throw new ValidationError("country", `unsupported country ${address.country}`);
  }
  if (!pattern.test(address.postalCode)) {
    throw new ValidationError("postalCode", `invalid postal code for ${address.country}`);
  }
  return address;
}
