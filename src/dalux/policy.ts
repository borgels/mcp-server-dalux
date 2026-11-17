import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigError } from '../config-env.js';

/**
 * Server-side guards that apply to every tool call, regardless of whether
 * it arrives over MCP or through the embeddable gateway entry point.
 *
 * - Write access is opt-in per instance (DALUX_ENABLE_WRITES=true). The
 *   Dalux Build API itself is read-only for Field data (tasks, forms,
 *   inspection/test plans); writes only exist for projects, companies and
 *   file upload, and those are the tools this flag gates.
 * - DALUX_DISABLED_TOOLS turns individual tools off.
 * - DALUX_ALLOWED_PROJECT_IDS restricts every call that names a project
 *   (projectId, or a pageLink into a project) to a fixed set of projects,
 *   and filters dalux_list_projects. Project creation is refused while it
 *   is set unless DALUX_ALLOW_PROJECT_CREATE=true. The account-wide company
 *   catalog, project templates and the metadata mappings that are not tied
 *   to a project (dalux_list_property_mappings with scope=companyCatalog, or
 *   scope=project without projectId) are not project-scoped and are not
 *   restricted by it.
 * - DALUX_LICENSE_PRECHECK=false turns off the Box Pro pre-check (see
 *   license.ts).
 * - DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS restricts the admin assigned when a
 *   project is created.
 *
 * Any client-side permission model sits on top of these; the environment
 * decides what the server will ever do.
 *
 * An embedding host that serves several tenants from one process passes a
 * DaluxInstancePolicy to the gateway instead. That instance's calls then run
 * with the host's policy and read none of the DALUX_* policy or audit
 * variables above, so a tenant's settings never come from a value the whole
 * process shares.
 */

/** Receives one audit record (the JSON object the audit log would hold). */
export type DaluxAuditSink = (record: Readonly<Record<string, unknown>>) => void | Promise<void>;

/** Policy given by an embedding host for one gateway instance. Every field is optional. */
export interface DaluxInstancePolicy {
  /** Allow the write tools. Default false. */
  enableWrites?: boolean;
  /** Tools turned off on this instance, with or without the `dalux_` prefix. Must name known tools. */
  disabledTools?: readonly string[];
  /** Restrict every call that names a project to these project ids. Unset: no allowlist. Must not be empty. */
  allowedProjectIds?: readonly string[];
  /** Allow project creation while allowedProjectIds is set. Default false. */
  allowProjectCreate?: boolean;
  /** Restrict the admin assigned when a project is created to these e-mail domains. Must not be empty. */
  allowedAdminEmailDomains?: readonly string[];
  /** The Box Pro pre-check before an upload. Default true. */
  licensePrecheck?: boolean;
  /**
   * Receives every audit record of this instance's calls, instead of
   * DALUX_AUDIT_LOG. Without it the instance writes no audit records. A write
   * tool runs only if its start record was accepted, so a sink that throws
   * refuses the write.
   */
  audit?: DaluxAuditSink;
}

/** A DaluxInstancePolicy, checked and normalised. */
export interface ResolvedDaluxPolicy {
  readonly enableWrites: boolean;
  readonly disabledTools: ReadonlySet<string>;
  readonly allowedProjectIds?: ReadonlySet<string>;
  readonly allowProjectCreate: boolean;
  readonly allowedAdminEmailDomains?: readonly string[];
  readonly licensePrecheck: boolean;
  readonly audit?: DaluxAuditSink;
}

const hostPolicy = new AsyncLocalStorage<ResolvedDaluxPolicy>();

function optionalBoolean(policy: DaluxInstancePolicy, name: keyof DaluxInstancePolicy): void {
  if (policy[name] !== undefined && typeof policy[name] !== 'boolean') {
    throw new ConfigError(`policy.${name} must be a boolean`);
  }
}

function optionalList(policy: DaluxInstancePolicy, name: keyof DaluxInstancePolicy): string[] | undefined {
  const value: unknown = policy[name];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new ConfigError(`policy.${name} must be an array of strings`);
  }
  const entries = value.map(entry => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    // An empty allowlist would read as "no allowlist"; refuse it so a mistake cannot turn one off.
    throw new ConfigError(`policy.${name} is empty; leave it out or list at least one value`);
  }
  return entries;
}

/** Check a host's policy. Throws ConfigError on anything unclear, including unknown tool names. */
export function resolveInstancePolicy(policy: DaluxInstancePolicy): ResolvedDaluxPolicy {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new ConfigError('policy must be an object');
  }
  optionalBoolean(policy, 'enableWrites');
  optionalBoolean(policy, 'allowProjectCreate');
  optionalBoolean(policy, 'licensePrecheck');
  if (policy.audit !== undefined && typeof policy.audit !== 'function') {
    throw new ConfigError('policy.audit must be a function');
  }
  const disabled = new Set<string>();
  if (policy.disabledTools !== undefined) {
    if (!Array.isArray(policy.disabledTools) || policy.disabledTools.some(entry => typeof entry !== 'string')) {
      throw new ConfigError('policy.disabledTools must be an array of tool names');
    }
    for (const name of policy.disabledTools) {
      const canonical = canonicalToolName(name);
      if (!READ_TOOLS.has(canonical) && !WRITE_TOOLS.has(canonical)) {
        throw new ConfigError(`policy.disabledTools names an unknown tool: ${name.slice(0, 100)}`);
      }
      disabled.add(canonical);
    }
  }
  const projects = optionalList(policy, 'allowedProjectIds');
  const domains = optionalList(policy, 'allowedAdminEmailDomains');
  return Object.freeze({
    enableWrites: policy.enableWrites === true,
    disabledTools: disabled,
    ...(projects ? { allowedProjectIds: new Set(projects) } : {}),
    allowProjectCreate: policy.allowProjectCreate === true,
    ...(domains ? { allowedAdminEmailDomains: Object.freeze(domains) } : {}),
    licensePrecheck: policy.licensePrecheck !== false,
    ...(policy.audit ? { audit: policy.audit } : {}),
  });
}

/** Run `work` (and everything it awaits) under a host's policy. */
export function runWithInstancePolicy<T>(policy: ResolvedDaluxPolicy, work: () => T): T {
  return hostPolicy.run(policy, work);
}

/** The host's policy of the call in progress, or undefined outside one (the environment applies). */
export function currentInstancePolicy(): ResolvedDaluxPolicy | undefined {
  return hostPolicy.getStore();
}

export function writesEnabled(): boolean {
  const hosted = currentInstancePolicy();
  if (hosted) {
    return hosted.enableWrites;
  }
  return process.env.DALUX_ENABLE_WRITES === 'true';
}

/** The Box Pro pre-check is on unless DALUX_LICENSE_PRECHECK is exactly `false` (or the host's policy turns it off). */
export function licensePrecheckEnabled(): boolean {
  const hosted = currentInstancePolicy();
  if (hosted) {
    return hosted.licensePrecheck;
  }
  return process.env.DALUX_LICENSE_PRECHECK !== 'false';
}

export function assertWritesEnabled(action: string): void {
  if (!writesEnabled()) {
    throw new Error(
      `Write access is disabled on this Dalux MCP instance (${action}). ` +
        (currentInstancePolicy()
          ? 'The embedding host has not enabled writes for this instance.'
          : 'Set DALUX_ENABLE_WRITES=true in the server environment to allow write tools.'),
    );
  }
}

export interface DaluxPolicyDecision {
  allowed: boolean;
  reason: string;
}

export const READ_TOOLS: ReadonlySet<string> = new Set([
  'dalux_search_capabilities',
  'dalux_list_projects',
  'dalux_get_project',
  'dalux_list_project_users',
  'dalux_list_tasks',
  'dalux_get_task',
  'dalux_get_task_changes',
  'dalux_list_task_attachments',
  'dalux_list_forms',
  'dalux_get_form',
  'dalux_list_form_attachments',
  'dalux_list_quality_plans',
  'dalux_export_quality_plans',
  'dalux_list_work_packages',
  'dalux_list_file_areas',
  'dalux_list_folders',
  'dalux_list_files',
  'dalux_list_version_sets',
  'dalux_download_file',
  'dalux_list_companies',
  'dalux_list_property_mappings',
]);

export const WRITE_TOOLS: ReadonlySet<string> = new Set(['dalux_upload_file', 'dalux_change_company', 'dalux_change_project']);

/**
 * Parse a comma-separated env var into trimmed, non-empty entries.
 * Unset or empty means "not configured" (undefined). A value that holds
 * only separators or blanks is a configuration error, so a typo can never
 * silently turn an allowlist off.
 */
export function envList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const entries = raw
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`${name} is set but contains no entries; unset it or list at least one value.`);
  }
  return entries;
}

/**
 * Validate the policy environment once at startup. Throws on blank-only
 * lists and on unknown tool names in DALUX_DISABLED_TOOLS.
 */
export function validatePolicyConfig(): void {
  const precheck = process.env.DALUX_LICENSE_PRECHECK;
  if (precheck !== undefined && precheck !== '' && precheck !== 'true' && precheck !== 'false') {
    throw new Error('DALUX_LICENSE_PRECHECK must be "true" or "false".');
  }
  envList('DALUX_ALLOWED_PROJECT_IDS');
  envList('DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS');
  const unknown = (envList('DALUX_DISABLED_TOOLS') ?? [])
    .map(canonicalToolName)
    .filter(name => !READ_TOOLS.has(name) && !WRITE_TOOLS.has(name));
  if (unknown.length > 0) {
    throw new Error(`DALUX_DISABLED_TOOLS names unknown tools: ${unknown.join(', ')}`);
  }
}

export function isToolDisabled(toolName: string): boolean {
  return disabledTools().has(canonicalToolName(toolName));
}

/** The project allowlist, or undefined when no allowlist is configured. */
export function allowedProjectIds(): ReadonlySet<string> | undefined {
  const hosted = currentInstancePolicy();
  if (hosted) {
    return hosted.allowedProjectIds;
  }
  const list = envList('DALUX_ALLOWED_PROJECT_IDS');
  return list ? new Set(list) : undefined;
}

/** Tool names are accepted with or without the `dalux_` prefix. */
function canonicalToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.startsWith('dalux_') ? lower : `dalux_${lower}`;
}

function disabledTools(): ReadonlySet<string> {
  const hosted = currentInstancePolicy();
  if (hosted) {
    return hosted.disabledTools;
  }
  return new Set((envList('DALUX_DISABLED_TOOLS') ?? []).map(canonicalToolName));
}

export function checkToolPolicy(toolName: string): DaluxPolicyDecision {
  const known = READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName);
  if (!known) {
    return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
  }

  if (disabledTools().has(toolName)) {
    return { allowed: false, reason: `tool is disabled on this instance (DALUX_DISABLED_TOOLS): ${toolName}` };
  }

  if (READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Dalux tool' };
  }

  if (!writesEnabled()) {
    return {
      allowed: false,
      reason: `write tool is disabled on this instance (DALUX_ENABLE_WRITES != true): ${toolName}`,
    };
  }
  return { allowed: true, reason: 'write tool (writes enabled on this instance)' };
}

/**
 * Input-dependent checks: the project allowlist (any call naming a
 * project), project creation while an allowlist is set, and the admin
 * e-mail domain allowlist.
 */
export function checkInputPolicy(toolName: string, input: unknown): DaluxPolicyDecision {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  const allowedProjects = allowedProjectIds();
  if (allowedProjects) {
    if (value.projectId !== undefined) {
      const projectId = String(value.projectId).trim();
      if (!allowedProjects.has(projectId)) {
        return deny(`project ${projectId} is not in DALUX_ALLOWED_PROJECT_IDS on this instance (${toolName})`);
      }
    }

    if (typeof value.pageLink === 'string') {
      const linkProject = projectIdInLink(value.pageLink);
      // Exact, case-sensitive comparison (the client's own resource check is case-insensitive).
      const requested = value.projectId === undefined ? undefined : String(value.projectId).trim();
      const outside = !allowedProjects.has(linkProject ?? '') || (requested !== undefined && linkProject !== requested);
      if (linkProject !== undefined && outside) {
        return deny(`pageLink points at a project outside the request or DALUX_ALLOWED_PROJECT_IDS (${toolName})`);
      }
    }

    if (toolName === 'dalux_change_project' && value.action === 'create' && !projectCreateAllowed()) {
      return deny(
        'project creation is not project-scoped and is refused while DALUX_ALLOWED_PROJECT_IDS is set; ' +
          'set DALUX_ALLOW_PROJECT_CREATE=true to allow it',
      );
    }
  }

  const allowedDomains = adminEmailDomains()?.map(domain =>
    domain.toLowerCase().replace(/^@/, ''),
  );
  if (allowedDomains && value.adminEmail !== undefined) {
    const domain = emailDomain(String(value.adminEmail));
    if (!domain || !allowedDomains.includes(domain)) {
      return deny(`adminEmail domain is not in DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS on this instance (${toolName})`);
    }
  }

  return { allowed: true, reason: 'input within instance allowlists' };
}

function projectCreateAllowed(): boolean {
  const hosted = currentInstancePolicy();
  return hosted ? hosted.allowProjectCreate : process.env.DALUX_ALLOW_PROJECT_CREATE === 'true';
}

function adminEmailDomains(): readonly string[] | undefined {
  const hosted = currentInstancePolicy();
  return hosted ? hosted.allowedAdminEmailDomains : envList('DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS');
}

function deny(reason: string): DaluxPolicyDecision {
  return { allowed: false, reason };
}

/** The (case-sensitive) project id segment of a Dalux link, if any. */
export function projectIdInLink(link: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(link).pathname;
  } catch {
    return undefined;
  }
  // Project metadata mappings not tied to a project:
  // /projects/metadata/<version>/mappings[/<key>/values]. A project whose id
  // is "metadata" has the path /projects/metadata/metadata/...
  const match = /\/projects\/([^/]+)/.exec(pathname);
  if (
    match?.[1] === 'metadata' &&
    /^\/projects\/metadata\/\d+(\.\d+)*\/mappings(\/|$)/.test(pathname.slice(match.index))
  ) {
    return undefined;
  }
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function emailDomain(email: string): string | undefined {
  const at = email.trim().lastIndexOf('@');
  if (at < 1) {
    return undefined;
  }
  return email.trim().slice(at + 1).toLowerCase() || undefined;
}
