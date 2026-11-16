import type { DaluxClient } from './client.js';
import { licensePrecheckEnabled } from './policy.js';
import { encodePathParam } from '../path-params.js';

/**
 * Project modules (ProjectModule in the Dalux Build API 4.15). Only
 * GET /5.0/projects/{projectId} returns them; the project list does not.
 *
 * Observed, not documented by Dalux: the Box endpoints (file areas, folders,
 * files, version sets, download, upload, file property mappings) answer
 * 403 E40301 unless the project has Box Pro. requireBoxPro fails fast before
 * such a call when the modules say the project does not have it. Anything
 * the check cannot interpret, and any failed lookup, lets the real call go
 * ahead. DALUX_LICENSE_PRECHECK=false turns the check off.
 */
export interface ProjectModule {
  type?: unknown;
  tier?: unknown;
  restriction?: unknown;
}

export interface LicenseSummary {
  /** Box tier, or null when the project has no Box module. */
  box: string | null;
  /** Field tier, or null when the project has no Field module. */
  field: string | null;
  /** Module restrictions as `<module>:<restriction>`, e.g. `box:trial`. */
  restrictions: string[];
}

export class LicenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseError';
  }
}

/** How long known modules are reused. */
export const MODULE_CACHE_TTL_MS = 5 * 60 * 1000;
/** How long an unknown result (failed lookup, no modules) suppresses another lookup. */
export const UNKNOWN_CACHE_TTL_MS = 60 * 1000;
export const MODULE_CACHE_MAX_ENTRIES = 500;
/** Upper bound for the lookup timeout (DALUX_TIMEOUT_MS applies when lower). */
export const LOOKUP_TIMEOUT_MS = 5000;

/** Box tiers from the spec that are not Box Pro. */
const NON_PRO_BOX_TIERS = new Set(['light', 'basic', 'standard', 'field']);

interface CacheEntry {
  /** undefined: unknown, do not look up again before expiresAt. */
  modules: ProjectModule[] | undefined;
  expiresAt: number;
}

interface ClientCache {
  entries: Map<string, CacheEntry>;
  inFlight: Map<string, Promise<ProjectModule[] | undefined>>;
}

const caches = new WeakMap<DaluxClient, ClientCache>();

function cacheFor(client: DaluxClient): ClientCache {
  let cache = caches.get(client);
  if (!cache) {
    cache = { entries: new Map(), inFlight: new Map() };
    caches.set(client, cache);
  }
  return cache;
}

function store(cache: ClientCache, projectId: string, modules: ProjectModule[] | undefined, now: number): void {
  cache.entries.delete(projectId);
  cache.entries.set(projectId, {
    modules,
    expiresAt: now + (modules ? MODULE_CACHE_TTL_MS : UNKNOWN_CACHE_TTL_MS),
  });
  while (cache.entries.size > MODULE_CACHE_MAX_ENTRIES) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.entries.delete(oldest);
  }
}

/** The modules array of a project response (`{ data: { modules } }` or `{ modules }`), if present. */
export function modulesFromProject(response: unknown): ProjectModule[] | undefined {
  const record = asRecord(response);
  const data = asRecord(record?.data) ?? record;
  const modules = data?.modules;
  return Array.isArray(modules) ? (modules as ProjectModule[]) : undefined;
}

/** Remember the modules of a project response fetched elsewhere (e.g. dalux_get_project). */
export function rememberProjectModules(
  client: DaluxClient,
  projectId: string,
  response: unknown,
  now: number = Date.now(),
): ProjectModule[] | undefined {
  const modules = modulesFromProject(response);
  if (modules) {
    store(cacheFor(client), projectId, modules, now);
  }
  return modules;
}

/**
 * The project's modules from the cache or a single GET /5.0/projects/{id}
 * (one attempt, short timeout). Concurrent lookups for a project share one
 * request. Returns undefined when unknown; an unknown result is remembered
 * briefly so a project without readable modules is not looked up on every
 * call.
 */
export async function getProjectModules(
  client: DaluxClient,
  projectId: string,
  now: number = Date.now(),
): Promise<ProjectModule[] | undefined> {
  const cache = cacheFor(client);
  const cached = cache.entries.get(projectId);
  if (cached && cached.expiresAt > now) {
    return cached.modules;
  }
  const pending = cache.inFlight.get(projectId);
  if (pending) {
    return pending;
  }
  const lookup = (async () => {
    let modules: ProjectModule[] | undefined;
    try {
      const response = await client.getOnce(`/5.0/projects/${encodePathParam(projectId, 'projectId')}`, LOOKUP_TIMEOUT_MS);
      modules = modulesFromProject(response);
    } catch {
      modules = undefined;
    }
    store(cache, projectId, modules, now);
    return modules;
  })();
  cache.inFlight.set(projectId, lookup);
  try {
    return await lookup;
  } finally {
    cache.inFlight.delete(projectId);
  }
}

export function licenseSummary(modules: ProjectModule[]): LicenseSummary {
  const entries = modules.filter(isWellFormed);
  const tierOf = (type: string) => {
    const module = entries.find(entry => lower(entry.type) === type);
    return module ? (typeof module.tier === 'string' ? module.tier : 'unknown') : null;
  };
  const restrictions = entries
    .filter(entry => typeof entry.restriction === 'string' && entry.restriction)
    .map(entry => `${lower(entry.type)}:${entry.restriction as string}`);
  return { box: tierOf('box'), field: tierOf('field'), restrictions };
}

/**
 * The Box tier that rules out Box Pro, 'not enabled' when a well-formed
 * module list has no Box entry, or undefined when the project has Box Pro or
 * the modules cannot be interpreted.
 */
export function boxProBlocker(modules: ProjectModule[] | undefined): string | undefined {
  if (!modules || modules.length === 0) {
    return undefined;
  }
  const boxEntries = modules.filter(entry => isWellFormed(entry) && lower(entry.type) === 'box');
  if (boxEntries.some(entry => lower(entry.tier) === 'pro')) {
    return undefined;
  }
  if (boxEntries.length === 0) {
    return modules.every(isWellFormed) ? 'not enabled' : undefined;
  }
  const tiers = boxEntries.map(entry => lower(entry.tier));
  return tiers.every(tier => tier !== undefined && NON_PRO_BOX_TIERS.has(tier)) ? tiers[0] : undefined;
}

/** Fail fast when the project's modules show it does not have Box Pro. */
export async function requireBoxPro(client: DaluxClient, projectId: string): Promise<void> {
  if (!licensePrecheckEnabled()) {
    return;
  }
  const blocker = boxProBlocker(await getProjectModules(client, projectId));
  if (blocker === undefined) {
    return;
  }
  throw new LicenseError(
    `The Dalux Build API's Box endpoints require Box Pro; project ${projectId} has Box ${blocker}. ` +
      'Based on the project modules, cached for up to 5 minutes; dalux_get_project refreshes them after a license change.',
  );
}

function isWellFormed(entry: unknown): entry is ProjectModule & { type: string } {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof (entry as ProjectModule).type === 'string'
  );
}

function lower(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
