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
 *   catalog and project templates are not project-scoped and are not
 *   restricted by it.
 * - DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS restricts the admin assigned when a
 *   project is created.
 *
 * Any client-side permission model sits on top of these; the environment
 * decides what the server will ever do.
 */
export function writesEnabled(): boolean {
  return process.env.DALUX_ENABLE_WRITES === 'true';
}

export function assertWritesEnabled(action: string): void {
  if (!writesEnabled()) {
    throw new Error(
      `Write access is disabled on this Dalux MCP instance (${action}). ` +
        'Set DALUX_ENABLE_WRITES=true in the server environment to allow write tools.',
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
  'dalux_list_work_packages',
  'dalux_list_file_areas',
  'dalux_list_folders',
  'dalux_list_files',
  'dalux_list_version_sets',
  'dalux_download_file',
  'dalux_list_companies',
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
  const list = envList('DALUX_ALLOWED_PROJECT_IDS');
  return list ? new Set(list) : undefined;
}

/** Tool names are accepted with or without the `dalux_` prefix. */
function canonicalToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.startsWith('dalux_') ? lower : `dalux_${lower}`;
}

function disabledTools(): Set<string> {
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

    if (toolName === 'dalux_change_project' && value.action === 'create' && process.env.DALUX_ALLOW_PROJECT_CREATE !== 'true') {
      return deny(
        'project creation is not project-scoped and is refused while DALUX_ALLOWED_PROJECT_IDS is set; ' +
          'set DALUX_ALLOW_PROJECT_CREATE=true to allow it',
      );
    }
  }

  const allowedDomains = envList('DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS')?.map(domain =>
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
  const match = /\/projects\/([^/]+)/.exec(pathname);
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
