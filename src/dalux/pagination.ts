import type { DaluxClient, QueryValue } from './client.js';

/**
 * Dalux list responses carry full hyperlinks. Seen live (2026-09-23,
 * GET /5.1/projects): a `links` ARRAY of `{ rel, href, method }` plus
 * `metadata { totalItems, totalRemainingItems }`, with items wrapped in
 * `data`. The single `link { self, nextPage }` object the first version
 * assumed is still read, in case some endpoints answer that way.
 * Pagination is opaque-link-only: follow `nextPage` as provided, never
 * construct page URLs. Incremental lists signal "end of stream" by
 * `nextPage` equalling `self`; items can reappear on later pages (the
 * latest occurrence wins) and deletions come back as `deleted=true`.
 */
export interface DaluxLink {
  href?: string;
}

export interface DaluxRelLink {
  rel?: string;
  href?: string;
  method?: string;
}

export interface DaluxListResponse<T = unknown> {
  links?: DaluxRelLink[];
  metadata?: { totalItems?: number; totalRemainingItems?: number; [key: string]: unknown };
  link?: {
    self?: DaluxLink | string;
    nextPage?: DaluxLink | string;
    [key: string]: unknown;
  };
  items?: T[];
  [key: string]: unknown;
}

export interface PageResult<T = unknown> {
  items: T[];
  pagesFetched: number;
  /** Absolute link to continue from, or undefined when the list is exhausted. */
  nextPage?: string;
  /** True when the API signalled the end of an incremental list (nextPage == self). */
  endOfIncrementalStream: boolean;
}

export interface FetchPagesOptions {
  query?: Record<string, QueryValue>;
  /** Continue from a previously returned nextPage link instead of the path. */
  pageLink?: string;
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 5;
export const MAX_PAGES_LIMIT = 25;

export function linkHref(link: DaluxLink | string | undefined): string | undefined {
  if (typeof link === 'string') {
    return link;
  }
  return link?.href;
}

/** The self and nextPage links of a page, from `links[]` (rel) or the `link` object. */
export function pageLinks(response: DaluxListResponse): { self?: string; next?: string } {
  const rel = (...names: string[]) => response.links?.find((l) => l.rel !== undefined && names.includes(l.rel))?.href;
  return {
    self: rel('self') ?? linkHref(response.link?.self),
    next: rel('nextPage', 'next') ?? linkHref(response.link?.nextPage),
  };
}

export async function fetchPages<T = unknown>(
  client: DaluxClient,
  path: string,
  options: FetchPagesOptions = {},
): Promise<PageResult<T>> {
  const maxPages = Math.min(Math.max(options.maxPages ?? DEFAULT_MAX_PAGES, 1), MAX_PAGES_LIMIT);
  const items: T[] = [];
  let pagesFetched = 0;
  let nextPage: string | undefined;
  let endOfIncrementalStream = false;

  let response: DaluxListResponse<T> = options.pageLink
    ? await client.getAbsolute<DaluxListResponse<T>>(options.pageLink)
    : await client.get<DaluxListResponse<T>>(path, options.query);

  for (;;) {
    pagesFetched += 1;
    items.push(...(response.items ?? []));

    const { next, self } = pageLinks(response);

    if (!next) {
      nextPage = undefined;
      break;
    }

    if (self && next === self) {
      // Incremental list: the current last page points at itself.
      nextPage = next;
      endOfIncrementalStream = true;
      break;
    }

    if (pagesFetched >= maxPages) {
      nextPage = next;
      break;
    }

    response = await client.getAbsolute<DaluxListResponse<T>>(next);
  }

  return { items, pagesFetched, nextPage, endOfIncrementalStream };
}
