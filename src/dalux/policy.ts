/**
 * Server-side guards that apply to every tool call, regardless of whether
 * it arrives over MCP or through the embeddable gateway entry point.
 *
 * - Write access is opt-in per instance (DALUX_ENABLE_WRITES=true). The
 *   Dalux Build API itself is read-only for Field data (tasks, forms,
 *   inspection/test plans); writes only exist for projects, companies and
 *   file upload, and those are the tools this flag gates.
 * - DALUX_DISABLED_TOOLS turns individual tools off.
 * - DALUX_ALLOWED_PROJECT_IDS restricts every project-scoped tool to a
 *   fixed set of projects.
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

const READ_TOOLS = new Set([
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

const WRITE_TOOLS = new Set(['dalux_upload_file', 'dalux_change_company', 'dalux_change_project']);

/** Parse a comma-separated env var into trimmed, non-empty entries. */
export function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

/** Tool names are accepted with or without the `dalux_` prefix. */
function canonicalToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.startsWith('dalux_') ? lower : `dalux_${lower}`;
}

function disabledTools(): Set<string> {
  return new Set(envList('DALUX_DISABLED_TOOLS').map(canonicalToolName));
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
 * Input-dependent checks: the project allowlist (any tool given a
 * projectId) and the admin e-mail domain allowlist (project creation).
 */
export function checkInputPolicy(toolName: string, input: unknown): DaluxPolicyDecision {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  const allowedProjects = envList('DALUX_ALLOWED_PROJECT_IDS');
  if (allowedProjects.length > 0 && value.projectId !== undefined) {
    const projectId = String(value.projectId).trim();
    if (!allowedProjects.includes(projectId)) {
      return {
        allowed: false,
        reason: `project ${projectId} is not in DALUX_ALLOWED_PROJECT_IDS on this instance (${toolName})`,
      };
    }
  }

  const allowedDomains = envList('DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS').map(domain =>
    domain.toLowerCase().replace(/^@/, ''),
  );
  if (allowedDomains.length > 0 && value.adminEmail !== undefined) {
    const domain = emailDomain(String(value.adminEmail));
    if (!domain || !allowedDomains.includes(domain)) {
      return {
        allowed: false,
        reason: `adminEmail domain is not in DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS on this instance (${toolName})`,
      };
    }
  }

  return { allowed: true, reason: 'input within instance allowlists' };
}

export function emailDomain(email: string): string | undefined {
  const at = email.trim().lastIndexOf('@');
  if (at < 1) {
    return undefined;
  }
  return email.trim().slice(at + 1).toLowerCase() || undefined;
}
