import { describe, expect, it } from "vitest";
import { normaliseRequest, paginate } from "./pagination.ts";

const items = Array.from({ length: 55 }, (_, i) => i + 1);

describe("normaliseRequest", () => {
  it("applies defaults", () => {
    expect(normaliseRequest({})).toEqual({ page: 1, size: 25 });
  });

  it("caps the page size", () => {
    expect(normaliseRequest({ size: 5000 }).size).toBe(100);
  });
});

describe("paginate", () => {
  it("returns the first page", () => {
    const page = paginate(items, { page: 1, size: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.items[0]).toBe(1);
    expect(page.totalPages).toBe(6);
    expect(page.hasPrevious).toBe(false);
    expect(page.hasNext).toBe(true);
  });

  it("returns a middle page", () => {
    const page = paginate(items, { page: 3, size: 10 });
    expect(page.items[0]).toBe(21);
    expect(page.items.at(-1)).toBe(30);
  });
});
