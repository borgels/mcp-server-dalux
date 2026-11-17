import type { DaluxClient } from './client.js';
import { fetchPages, MAX_PAGES_LIMIT } from './pagination.js';
import { allowedProjectIds } from './policy.js';

/**
 * Project references.
 *
 * Every Dalux Build API path takes the internal project id (`projectId` in
 * the project list, a long numeric id). People, and models working for
 * them, usually know a project by its number (`number`) or its name
 * (`projectName`) instead, and passing either one gets an HTTP 400/404 from
 * Dalux. resolveProjectRef turns such a reference into the internal id:
 *
 * - A value that looks like an internal id, or that is listed in
 *   DALUX_ALLOWED_PROJECT_IDS, is used unchanged without any extra request.
 * - Anything else is looked up in the project list (GET /5.1/projects,
 *   cached per client instance for a short time): exact projectId first,
 *   then exact project number, then exact name (both trimmed and
 *   case-insensitive). No match, or more than one, is a ProjectRefError that
 *   lists a few candidates the caller can retry with.
 * - With DALUX_ALLOWED_PROJECT_IDS set, only allowlisted projects take part
 *   in the lookup, so the resolution never reveals other projects.
 * - If the project list cannot be read, the value is used unchanged and
 *   Dalux answers as it would have without the lookup.
 */

/** Long numeric ids, as the project list returns them, or `S` followed by digits. */
const INTERNAL_ID_PATTERN = /^(?:\d{12,}|S\d{6,})$/;

/** The project list the lookup reads (GET). */
export const PROJECT_LIST_PATH = '/5.1/projects';

/** How long a fetched project list is reused. */
export const PROJECT_LIST_TTL_MS = 60 * 1000;
/** How long a failed project list lookup suppresses another one. */
export const PROJECT_LIST_FAILURE_TTL_MS = 15 * 1000;
/** Candidates listed in a ProjectRefError. */
export const MAX_CANDIDATES = 5;

export interface ProjectSummary {
  projectId: string;
  number?: string;
  projectName?: string;
}

export interface ProjectRefResolution {
  projectId: string;
  /** How the value was matched; `id` means it was used unchanged. */
  matchedBy: 'id' | 'number' | 'name';
}

export class ProjectRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRefError';
  }
}

interface ListEntry {
  /** undefined: the lookup failed; pass references through until expiresAt. */
  projects: ProjectSummary[] | undefined;
  /** More projects exist than one lookup reads. */
  truncated: boolean;
  expiresAt: number;
}

interface ClientCache {
  entry?: ListEntry;
  inFlight?: Promise<ListEntry>;
}

const caches = new WeakMap<DaluxClient, ClientCache>();

function cacheFor(client: DaluxClient): ClientCache {
  let cache = caches.get(client);
  if (!cache) {
    cache = {};
    caches.set(client, cache);
  }
  return cache;
}

export function looksLikeInternalProjectId(value: string): boolean {
  return INTERNAL_ID_PATTERN.test(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/** A project list item (`{ data: {...} }` or the bare object) as a summary. */
export function projectSummary(item: unknown): ProjectSummary | undefined {
  const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
  const data = (record?.data && typeof record.data === 'object' ? record.data : record) as
    | Record<string, unknown>
    | undefined;
  const projectId = text(data?.projectId);
  if (!projectId) {
    return undefined;
  }
  return { projectId, number: text(data?.number), projectName: text(data?.projectName) };
}

async function loadProjects(client: DaluxClient, now: number): Promise<ListEntry> {
  const cache = cacheFor(client);
  if (cache.entry && cache.entry.expiresAt > now) {
    return cache.entry;
  }
  if (cache.inFlight) {
    return cache.inFlight;
  }
  const lookup = (async (): Promise<ListEntry> => {
    let entry: ListEntry;
    try {
      const result = await fetchPages(client, PROJECT_LIST_PATH, { maxPages: MAX_PAGES_LIMIT });
      const projects = result.items.map(projectSummary).filter((p): p is ProjectSummary => p !== undefined);
      entry = {
        projects,
        truncated: result.nextPage !== undefined && !result.endOfIncrementalStream,
        expiresAt: now + PROJECT_LIST_TTL_MS,
      };
    } catch {
      entry = { projects: undefined, truncated: false, expiresAt: now + PROJECT_LIST_FAILURE_TTL_MS };
    }
    cache.entry = entry;
    return entry;
  })();
  cache.inFlight = lookup;
  try {
    return await lookup;
  } finally {
    cache.inFlight = undefined;
  }
}

const normalise = (value: string) => value.trim().toLowerCase();

function describe(project: ProjectSummary): string {
  const parts = [
    project.number ? `number ${JSON.stringify(project.number)}` : undefined,
    project.projectName ? `name ${JSON.stringify(project.projectName)}` : undefined,
    `projectId ${project.projectId}`,
  ].filter(Boolean);
  return parts.join(', ');
}

function candidateList(projects: ProjectSummary[]): string {
  const shown = projects.slice(0, MAX_CANDIDATES).map(p => `- ${describe(p)}`);
  const more = projects.length > MAX_CANDIDATES ? [`- … and ${projects.length - MAX_CANDIDATES} more`] : [];
  return [...shown, ...more].join('\n');
}

/** Projects whose number or name contains the reference, for the not-found hint. */
function similar(projects: ProjectSummary[], ref: string): ProjectSummary[] {
  const needle = normalise(ref);
  return projects.filter(
    p => (p.number && normalise(p.number).includes(needle)) || (p.projectName && normalise(p.projectName).includes(needle)),
  );
}

/**
 * Resolve a project reference (internal id, project number or exact name)
 * to the internal project id. See the module comment for the rules.
 */
export async function resolveProjectRef(
  client: DaluxClient,
  value: string,
  now: number = Date.now(),
): Promise<ProjectRefResolution> {
  const ref = value.trim();
  const allowed = allowedProjectIds();
  if (looksLikeInternalProjectId(ref) || allowed?.has(ref)) {
    return { projectId: ref, matchedBy: 'id' };
  }

  const entry = await loadProjects(client, now);
  if (!entry.projects) {
    return { projectId: ref, matchedBy: 'id' };
  }
  const projects = allowed ? entry.projects.filter(p => allowed.has(p.projectId)) : entry.projects;

  if (projects.some(p => p.projectId === ref)) {
    return { projectId: ref, matchedBy: 'id' };
  }

  const key = normalise(ref);
  const byNumber = projects.filter(p => p.number !== undefined && normalise(p.number) === key);
  if (byNumber.length === 1) {
    return { projectId: byNumber[0]!.projectId, matchedBy: 'number' };
  }
  const byName = byNumber.length === 0 ? projects.filter(p => p.projectName !== undefined && normalise(p.projectName) === key) : [];
  if (byName.length === 1) {
    return { projectId: byName[0]!.projectId, matchedBy: 'name' };
  }

  const ambiguous = byNumber.length > 1 ? byNumber : byName;
  if (ambiguous.length > 1) {
    const field = byNumber.length > 1 ? 'number' : 'name';
    throw new ProjectRefError(
      `Project reference ${JSON.stringify(ref)} matches ${ambiguous.length} projects by ${field}; ` +
        `retry with one of these projectId values:\n${candidateList(ambiguous)}`,
    );
  }

  if (entry.truncated) {
    // The lookup did not see every project; let Dalux decide.
    return { projectId: ref, matchedBy: 'id' };
  }

  const hints = similar(projects, ref);
  const scope = allowed ? 'projects allowed on this instance' : 'projects visible to this API identity';
  throw new ProjectRefError(
    `No project with id, number or name ${JSON.stringify(ref)} among the ${scope}. ` +
      (hints.length > 0
        ? `Similar projects (pass the projectId):\n${candidateList(hints)}`
        : 'Call dalux_list_projects and pass the projectId of the project.'),
  );
}

/** Forget the cached project list of a client (after a project is created or renamed). */
export function forgetProjectList(client: DaluxClient): void {
  const cache = caches.get(client);
  if (cache) {
    cache.entry = undefined;
  }
}
