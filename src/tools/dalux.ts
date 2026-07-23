import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../dalux/audit.js';
import {
  READ_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  searchCapabilities,
} from '../dalux/capabilities.js';
import type { DaluxClient } from '../dalux/client.js';
import { checkToolPolicy } from '../dalux/policy.js';
import { MAX_PAGES_LIMIT } from '../dalux/pagination.js';
import {
  createProject,
  getProject,
  listProjectTemplates,
  listProjects,
  listProjectUsers,
  listWorkPackages,
  updateProject,
} from '../dalux/projects.js';
import { getTask, getTaskChanges, listTaskAttachments, listTasks } from '../dalux/tasks.js';
import { getForm, listFormAttachments, listForms, listQualityPlans } from '../dalux/forms.js';
import { downloadFile, listFileAreas, listFiles, listFolders, listVersionSets, uploadFile } from '../dalux/box.js';
import { changeCompany, listCompanyCatalog, listProjectCompanies } from '../dalux/companies.js';

const projectIdSchema = z.string().trim().min(1).describe('Project id from dalux_list_projects.');
const pageLinkSchema = z
  .string()
  .trim()
  .url()
  .optional()
  .describe('Opaque nextPage link from a previous call — continues that list instead of starting over.');
const maxPagesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGES_LIMIT)
  .optional()
  .describe(`How many pages to fetch in one call (default 5, max ${MAX_PAGES_LIMIT}).`);

const listShape = {
  pageLink: pageLinkSchema,
  maxPages: maxPagesSchema,
};

export function registerDaluxTools(server: McpServer, client: DaluxClient): void {
  server.registerTool(
    'dalux_search_capabilities',
    {
      title: 'Search Dalux Capabilities',
      description:
        'Search the Dalux MCP server capabilities and examples. Use this first when deciding which Dalux tool to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_search_capabilities', input, async () =>
        jsonToolResult(searchCapabilities(input.query, input.limit)),
      ),
  );

  server.registerTool(
    'dalux_list_projects',
    {
      title: 'List Projects (Dalux)',
      description:
        'List all Dalux projects the API identity can see: name, type (building/infrastructure), address, number, and enabled modules. Also lists project templates with includeTemplates=true.',
      inputSchema: {
        includeTemplates: z.boolean().default(false).describe('List project templates instead of projects.'),
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_projects', input, async () =>
        jsonToolResult(
          input.includeTemplates ? await listProjectTemplates(client, input) : await listProjects(client, input),
        ),
      ),
  );

  server.registerTool(
    'dalux_get_project',
    {
      title: 'Get Project (Dalux)',
      description: 'Fetch one Dalux project, optionally with its metadata fields.',
      inputSchema: {
        projectId: projectIdSchema,
        includeMetadata: z.boolean().default(false),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_get_project', input, async () => jsonToolResult(await getProject(client, input))),
  );

  server.registerTool(
    'dalux_list_project_users',
    {
      title: 'List Project Users (Dalux)',
      description:
        'List users on a Dalux project (name, email, company, user groups), or fetch a single user with userId. The Dalux API cannot create or modify users.',
      inputSchema: {
        projectId: projectIdSchema,
        userId: z.string().trim().min(1).optional(),
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_project_users', input, async () =>
        jsonToolResult(await listProjectUsers(client, input)),
      ),
  );

  server.registerTool(
    'dalux_list_tasks',
    {
      title: 'List Tasks (Dalux Field)',
      description:
        'List tasks, approvals, safety issues, safety observations, and good practices on a Dalux Field project, with subject, type, workflow state, location (building/level/room/drawing), and user-defined fields. Optional typeId filter (the only server-side filter Dalux supports). NOTE: the Dalux API is read-only for tasks.',
      inputSchema: {
        projectId: projectIdSchema,
        typeId: z.string().trim().min(1).optional().describe("Task type id — filters via OData: data/type/typeId eq '<id>'."),
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_tasks', input, async () => jsonToolResult(await listTasks(client, input))),
  );

  server.registerTool(
    'dalux_get_task',
    {
      title: 'Get Task (Dalux Field)',
      description: 'Fetch one Dalux Field task/safety issue with full details.',
      inputSchema: {
        projectId: projectIdSchema,
        taskId: z.string().trim().min(1),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_get_task', input, async () => jsonToolResult(await getTask(client, input))),
  );

  server.registerTool(
    'dalux_get_task_changes',
    {
      title: 'Get Task Changes (Dalux Field)',
      description:
        'Incremental change feed for all tasks/approvals/safety items on a project. Dalux has no webhooks — polling this feed is the supported sync pattern. Keep the returned nextPage and pass it as pageLink later to fetch only new changes (stream end is signalled by endOfIncrementalStream=true).',
      inputSchema: {
        projectId: projectIdSchema,
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_get_task_changes', input, async () =>
        jsonToolResult(await getTaskChanges(client, input)),
      ),
  );

  server.registerTool(
    'dalux_list_task_attachments',
    {
      title: 'List Task Attachments (Dalux Field)',
      description: 'List attachments (photos, documents) across all tasks on a project, with media links.',
      inputSchema: {
        projectId: projectIdSchema,
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_task_attachments', input, async () =>
        jsonToolResult(await listTaskAttachments(client, input)),
      ),
  );

  server.registerTool(
    'dalux_list_forms',
    {
      title: 'List Forms (Dalux Field)',
      description:
        'List registered forms/checklists (APV, kvalitetssikring, tilsyn) on a project. Incremental list. Read-only — forms cannot be created or filled through the API.',
      inputSchema: {
        projectId: projectIdSchema,
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_forms', input, async () => jsonToolResult(await listForms(client, input))),
  );

  server.registerTool(
    'dalux_get_form',
    {
      title: 'Get Form (Dalux Field)',
      description: 'Fetch one form with all its answered fields.',
      inputSchema: {
        projectId: projectIdSchema,
        formId: z.string().trim().min(1),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_get_form', input, async () => jsonToolResult(await getForm(client, input))),
  );

  server.registerTool(
    'dalux_list_form_attachments',
    {
      title: 'List Form Attachments (Dalux Field)',
      description: 'List attachments across all forms on a project.',
      inputSchema: {
        projectId: projectIdSchema,
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_form_attachments', input, async () =>
        jsonToolResult(await listFormAttachments(client, input)),
      ),
  );

  server.registerTool(
    'dalux_list_quality_plans',
    {
      title: 'List Inspection/Test Plans (Dalux Field)',
      description:
        'List quality assurance data: inspection plans (kontrolplaner) or test plans, and their items, item zones, or registrations.',
      inputSchema: {
        projectId: projectIdSchema,
        kind: z.enum(['inspection', 'test']),
        part: z.enum(['plans', 'items', 'itemZones', 'registrations']).default('plans'),
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_quality_plans', input, async () =>
        jsonToolResult(await listQualityPlans(client, input)),
      ),
  );

  server.registerTool(
    'dalux_list_work_packages',
    {
      title: 'List Work Packages (Dalux)',
      description: 'List work packages (arbejdspakker) on a project.',
      inputSchema: {
        projectId: projectIdSchema,
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_work_packages', input, async () =>
        jsonToolResult(await listWorkPackages(client, input)),
      ),
  );

  server.registerTool(
    'dalux_list_file_areas',
    {
      title: 'List File Areas (Dalux Box)',
      description:
        'List document file areas on a project (or fetch one with fileAreaId). Entry point for all Box document access.',
      inputSchema: {
        projectId: projectIdSchema,
        fileAreaId: z.string().trim().min(1).optional(),
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_file_areas', input, async () =>
        jsonToolResult(await listFileAreas(client, input)),
      ),
  );

  server.registerTool(
    'dalux_list_folders',
    {
      title: 'List Folders (Dalux Box)',
      description: 'List folders within a file area (or fetch one with folderId).',
      inputSchema: {
        projectId: projectIdSchema,
        fileAreaId: z.string().trim().min(1),
        folderId: z.string().trim().min(1).optional(),
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_folders', input, async () => jsonToolResult(await listFolders(client, input))),
  );

  server.registerTool(
    'dalux_list_files',
    {
      title: 'List Files (Dalux Box)',
      description:
        'List files within a file area (or fetch one file’s metadata with fileId): name, revision ids, properties, folder, deleted status. Metadata only — use dalux_download_file for content. Incremental list.',
      inputSchema: {
        projectId: projectIdSchema,
        fileAreaId: z.string().trim().min(1),
        fileId: z.string().trim().min(1).optional(),
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_files', input, async () => jsonToolResult(await listFiles(client, input))),
  );

  server.registerTool(
    'dalux_list_version_sets',
    {
      title: 'List Version Sets (Dalux Box)',
      description:
        'List version sets on a project or file area, fetch one with versionSetId, or list its files with includeFiles=true.',
      inputSchema: {
        projectId: projectIdSchema,
        fileAreaId: z.string().trim().min(1).optional(),
        versionSetId: z.string().trim().min(1).optional(),
        includeFiles: z.boolean().default(false),
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_version_sets', input, async () =>
        jsonToolResult(await listVersionSets(client, input)),
      ),
  );

  server.registerTool(
    'dalux_download_file',
    {
      title: 'Download File (Dalux Box)',
      description:
        'Download the content of a specific file revision. Text-like content is returned as UTF-8, everything else base64. Default cap 50 MB; raise maxBytes for large KS drawings/models (server ceiling ~512 MB). Note: very large files base64-encoded into the response are heavy for the LLM context — for bulk KS export prefer fetching many files individually.',
      inputSchema: {
        projectId: projectIdSchema,
        fileAreaId: z.string().trim().min(1),
        fileId: z.string().trim().min(1),
        fileRevisionId: z.string().trim().min(1),
        maxBytes: z.number().int().min(1).max(2 * 1024 * 1024 * 1024).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_download_file', input, async () => jsonToolResult(await downloadFile(client, input))),
  );

  server.registerTool(
    'dalux_list_companies',
    {
      title: 'List Companies (Dalux)',
      description:
        'List companies on a project (scope=project, requires projectId) or the account-wide company catalog (scope=catalog). Optionally fetch one company with companyId.',
      inputSchema: {
        scope: z.enum(['project', 'catalog']).default('project'),
        projectId: z.string().trim().min(1).optional(),
        companyId: z.string().trim().min(1).optional(),
        ...listShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_list_companies', input, async () => {
        if (input.scope === 'project') {
          if (!input.projectId) {
            throw new Error('projectId is required when scope is "project".');
          }
          return jsonToolResult(
            await listProjectCompanies(client, { ...input, projectId: input.projectId }),
          );
        }
        return jsonToolResult(await listCompanyCatalog(client, { ...input, catalogCompanyId: input.companyId }));
      }),
  );

  server.registerTool(
    'dalux_upload_file',
    {
      title: 'Upload File (Dalux Box)',
      description:
        'Upload a document to a Dalux Box file area: a new file into a folder (folderId) or a new revision of an existing file (fileId). Handles the 3-step chunked upload flow. File areas of type "published"/"shared" cannot be uploaded to. Requires write access on this instance — confirm the target folder with the user before uploading.',
      inputSchema: {
        projectId: projectIdSchema,
        fileAreaId: z.string().trim().min(1),
        fileName: z.string().trim().min(1),
        fileType: z.enum(['document', 'drawing', 'model']).default('document'),
        contentBase64: z.string().min(1).describe('File content, base64-encoded.'),
        folderId: z.string().trim().min(1).optional().describe('Target folder for a NEW file.'),
        fileId: z.string().trim().min(1).optional().describe('Existing file id to upload a NEW REVISION of.'),
        properties: z.array(z.record(z.string(), z.unknown())).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_upload_file', input, async () => jsonToolResult(await uploadFile(client, input))),
  );

  server.registerTool(
    'dalux_change_company',
    {
      title: 'Create/Update Company (Dalux)',
      description:
        'Add a company to a project or the account-wide company catalog, or update one. Requires write access on this instance.',
      inputSchema: {
        scope: z.enum(['project', 'catalog']),
        action: z.enum(['create', 'update']),
        projectId: z.string().trim().min(1).optional(),
        companyId: z.string().trim().min(1).optional(),
        body: z.record(z.string(), z.unknown()),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_change_company', input, async () =>
        jsonToolResult(await changeCompany(client, input)),
      ),
  );

  server.registerTool(
    'dalux_change_project',
    {
      title: 'Create/Update Project (Dalux)',
      description:
        'Create a new Dalux project (applies the company default Field/Box configuration; adminEmail required) or update an existing one. Project creation may consume a license — confirm with the user first. Requires write access on this instance.',
      inputSchema: {
        action: z.enum(['create', 'update']),
        adminEmail: z.string().trim().email().optional().describe('Required for action=create.'),
        projectId: z.string().trim().min(1).optional().describe('Required for action=update.'),
        body: z.record(z.string(), z.unknown()).optional().describe('Project payload for create.'),
        patch: z.record(z.string(), z.unknown()).optional().describe('Fields to change for update.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('dalux_change_project', input, async () => {
        if (input.action === 'create') {
          if (!input.adminEmail || !input.body) {
            throw new Error('adminEmail and body are required for action=create.');
          }
          return jsonToolResult(await createProject(client, { adminEmail: input.adminEmail, body: input.body }));
        }
        if (!input.projectId || !input.patch) {
          throw new Error('projectId and patch are required for action=update.');
        }
        return jsonToolResult(await updateProject(client, { projectId: input.projectId, patch: input.patch }));
      }),
  );
}

async function runAuditedTool<T>(tool: string, input: unknown, call: () => Promise<T>): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);

  if (!policy.allowed) {
    await writeAuditEvent({ tool, action: 'policy_denied', target, reason: policy.reason });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, action: 'start', target, reason: policy.reason });

  try {
    const result = await call();
    await writeAuditEvent({ tool, action: 'finish', target, status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
    });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const value = input as Record<string, unknown>;
  return {
    projectId: value.projectId,
    taskId: value.taskId,
    formId: value.formId,
    fileAreaId: value.fileAreaId,
    folderId: value.folderId,
    fileId: value.fileId,
    fileRevisionId: value.fileRevisionId,
    versionSetId: value.versionSetId,
    userId: value.userId,
    companyId: value.companyId,
    typeId: value.typeId,
    kind: value.kind,
    part: value.part,
    scope: value.scope,
    action: value.action,
    fileName: value.fileName,
    query: value.query,
  };
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
