import type { CorpusCase } from "../types.ts";
import { CATEGORY_A } from "./category-a.ts";
import { CATEGORY_B } from "./category-b.ts";
import { CATEGORY_D } from "./category-d.ts";

export { CATEGORY_A } from "./category-a.ts";
export { CATEGORY_B } from "./category-b.ts";
export { CATEGORY_D } from "./category-d.ts";

export const ALL_CASES: CorpusCase[] = [...CATEGORY_A, ...CATEGORY_B, ...CATEGORY_D];

export function caseById(id: string): CorpusCase | undefined {
  return ALL_CASES.find((c) => c.id === id);
}
