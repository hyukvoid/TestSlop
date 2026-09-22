export interface PageRequest {
  page: number;
  size: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export function normaliseRequest(raw: Partial<PageRequest>): PageRequest {
  const size = Math.min(raw.size ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return {
    page: Math.max(1, raw.page ?? 1),
    size: Math.max(1, size),
  };
}

export function paginate<T>(all: readonly T[], request: Partial<PageRequest>): Page<T> {
  const { page, size } = normaliseRequest(request);
  const start = (page - 1) * size;
  const items = all.slice(start, start + size);
  const totalPages = Math.ceil(all.length / size);

  return {
    items,
    page,
    size,
    totalItems: all.length,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

/** Builds the Link header value used by the public API. */
export function linkHeader(page: Page<unknown>, baseUrl: string): string {
  const parts: string[] = [];
  if (page.hasPrevious) parts.push(`<${baseUrl}?page=${page.page - 1}&size=${page.size}>; rel="prev"`);
  if (page.hasNext) parts.push(`<${baseUrl}?page=${page.page + 1}&size=${page.size}>; rel="next"`);
  parts.push(`<${baseUrl}?page=1&size=${page.size}>; rel="first"`);
  parts.push(`<${baseUrl}?page=${Math.max(1, page.totalPages)}&size=${page.size}>; rel="last"`);
  return parts.join(", ");
}
