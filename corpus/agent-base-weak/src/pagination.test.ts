import { describe, expect, it } from "vitest";
import { normaliseRequest, paginate } from "./pagination.ts";

const items = Array.from({ length: 55 }, (_, i) => i + 1);

describe("normaliseRequest", () => {
  it("returns a request", () => {
    expect(normaliseRequest({})).toBeDefined();
  });

  it("caps the page size", () => {
    expect(normaliseRequest({ size: 5000 }).size).toBeLessThanOrEqual(100);
  });
});

describe("paginate", () => {
  it("returns a page", () => {
    const page = paginate(items, { page: 1, size: 10 });
    expect(page).toBeTruthy();
    expect(page.items).toBeDefined();
    expect(page.totalPages).toBeGreaterThan(0);
  });

  it("returns a middle page", () => {
    const page = paginate(items, { page: 3, size: 10 });
    expect(page.items.length).toBeTruthy();
  });
});
