import type { DaluxClient, QueryValue } from './client.js';

/**
 * All Dalux list responses carry a `link` object with full hyperlinks.
 * Pagination is opaque-link-only: follow `nextPage` as provided, never
 * construct page URLs. Incremental lists signal "end of stream" by
 * `nextPage` equalling `self`; items can reappear on later pages (the
 * latest occurrence wins) and deletions come back as `deleted=true`.
 */
export interface DaluxLink {
  href?: string;
}

export interface DaluxListResponse<T = unknown> {
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

    const next = linkHref(response.link?.nextPage);
    const self = linkHref(response.link?.self);

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
