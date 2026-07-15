/**
 * Write access is opt-in per instance, mirroring the other Borgels MCP
 * servers: the container env decides what the server will ever do, and
 * the gateway's group/duty model decides who may call which tool.
 *
 * Note the Dalux Build API itself is read-only for Field data (tasks,
 * forms, inspection/test plans). Writes only exist for projects,
 * companies, and file upload — those are the tools this flag gates.
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

export function checkToolPolicy(toolName: string): DaluxPolicyDecision {
  if (READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Dalux tool' };
  }

  if (WRITE_TOOLS.has(toolName)) {
    if (!writesEnabled()) {
      return {
        allowed: false,
        reason: `write tool is disabled on this instance (DALUX_ENABLE_WRITES != true): ${toolName}`,
      };
    }
    return { allowed: true, reason: 'write tool (writes enabled on this instance)' };
  }

  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}
