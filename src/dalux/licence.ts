import type { DaluxClient } from './client.js';
import { encodePathParam } from '../path-params.js';

/**
 * Project modules (ProjectModule in the Dalux Build API 4.15). Only
 * GET /5.0/projects/{projectId} returns them; the project list does not.
 *
 * The Box endpoints of the Build API (file areas, folders, files, version
 * sets, download, upload, file property mappings) answer 403 E40301 unless
 * the project has Box at tier `pro`. Field endpoints need the Field module.
 * These checks fail fast with a clear message before calling such an
 * endpoint. A failed module lookup never blocks a call: the real request is
 * made and Dalux decides.
 */
export interface ProjectModule {
  type?: string;
  tier?: string;
  restriction?: string;
}

export interface LicenceSummary {
  /** Box tier, or null when the project has no Box module. */
  box: string | null;
  /** Field tier, or null when the project has no Field module. */
  field: string | null;
  /** Module restrictions as `<module>:<restriction>`, e.g. `box:trial`. */
  restrictions: string[];
}

export class LicenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenceError';
  }
}

export const MODULE_CACHE_TTL_MS = 5 * 60 * 1000;
export const MODULE_CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  modules: ProjectModule[];
  expiresAt: number;
}

const caches = new WeakMap<DaluxClient, Map<string, CacheEntry>>();

function cacheFor(client: DaluxClient): Map<string, CacheEntry> {
  let cache = caches.get(client);
  if (!cache) {
    cache = new Map();
    caches.set(client, cache);
  }
  return cache;
}

/** The modules array of a project response (`{ data: { modules } }` or `{ modules }`), if present. */
export function modulesFromProject(response: unknown): ProjectModule[] | undefined {
  const record = asRecord(response);
  const data = asRecord(record?.data) ?? record;
  const modules = data?.modules;
  if (!Array.isArray(modules)) {
    return undefined;
  }
  return modules.filter((entry): entry is ProjectModule => typeof entry === 'object' && entry !== null);
}

/** Remember the modules of a project response fetched elsewhere (e.g. dalux_get_project). */
export function rememberProjectModules(
  client: DaluxClient,
  projectId: string,
  response: unknown,
  now: number = Date.now(),
): ProjectModule[] | undefined {
  const modules = modulesFromProject(response);
  if (!modules) {
    return undefined;
  }
  const cache = cacheFor(client);
  cache.delete(projectId);
  cache.set(projectId, { modules, expiresAt: now + MODULE_CACHE_TTL_MS });
  while (cache.size > MODULE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  return modules;
}

/**
 * The project's modules from the cache or GET /5.0/projects/{projectId}.
 * Returns undefined when they cannot be determined (lookup failed or the
 * response has no modules); failures are not cached.
 */
export async function getProjectModules(
  client: DaluxClient,
  projectId: string,
  now: number = Date.now(),
): Promise<ProjectModule[] | undefined> {
  const cache = cacheFor(client);
  const cached = cache.get(projectId);
  if (cached && cached.expiresAt > now) {
    return cached.modules;
  }
  if (cached) {
    cache.delete(projectId);
  }
  try {
    const response = await client.get(`/5.0/projects/${encodePathParam(projectId, 'projectId')}`);
    return rememberProjectModules(client, projectId, response, now);
  } catch {
    return undefined;
  }
}

export function licenceSummary(modules: ProjectModule[]): LicenceSummary {
  const tierOf = (type: string) => {
    const module = modules.find(entry => entry.type === type);
    return module ? (typeof module.tier === 'string' ? module.tier : 'unknown') : null;
  };
  const restrictions = modules
    .filter(entry => typeof entry.restriction === 'string' && entry.restriction)
    .map(entry => `${entry.type ?? 'unknown'}:${entry.restriction}`);
  return { box: tierOf('box'), field: tierOf('field'), restrictions };
}

/** Fail fast when the project is known not to have Box Pro. */
export async function requireBoxPro(client: DaluxClient, projectId: string): Promise<void> {
  const modules = await getProjectModules(client, projectId);
  if (!modules) {
    return;
  }
  const box = modules.find(entry => entry.type === 'box');
  if (box?.tier === 'pro') {
    return;
  }
  const tier = box ? (box.tier ?? 'with an unknown tier') : 'not enabled';
  throw new LicenceError(
    `The Dalux Build API's Box endpoints require Box Pro; project ${projectId} has Box ${tier}. ` +
      'This depends on the project licence in Dalux; retrying will not help.',
  );
}

/** Fail fast when the project is known not to have the Field module. */
export async function requireField(client: DaluxClient, projectId: string): Promise<void> {
  const modules = await getProjectModules(client, projectId);
  if (!modules || modules.some(entry => entry.type === 'field')) {
    return;
  }
  throw new LicenceError(
    `The Dalux Build API's Field endpoints require the Field module; project ${projectId} does not have Field enabled. ` +
      'This depends on the project licence in Dalux; retrying will not help.',
  );
}

/**
 * Fail fast on a write to a project restricted to read-only. With a module
 * type, only that module's restriction counts (e.g. uploads and Box);
 * without one, the project counts as read-only when every module is.
 */
export async function requireWritable(client: DaluxClient, projectId: string, moduleType?: string): Promise<void> {
  const modules = await getProjectModules(client, projectId);
  if (!modules || modules.length === 0) {
    return;
  }
  const relevant = moduleType ? modules.filter(entry => entry.type === moduleType) : modules;
  if (relevant.length === 0 || !relevant.every(entry => entry.restriction === 'readOnly')) {
    return;
  }
  const scope = moduleType ? `the ${moduleType} module of project ${projectId}` : `project ${projectId}`;
  throw new LicenceError(`Dalux restricts ${scope} to read-only (restriction readOnly); write calls are refused.`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
