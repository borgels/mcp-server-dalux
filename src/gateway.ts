import { DALUX_CAPABILITIES, searchCapabilities } from './dalux/capabilities.js';
import { DaluxClient, type DaluxClientOptions } from './dalux/client.js';
import { downloadFile, listFileAreas, listFiles, listFolders, listVersionSets, uploadFile } from './dalux/box.js';
import { changeCompany, listCompanyCatalog, listProjectCompanies } from './dalux/companies.js';
import { getForm, listFormAttachments, listForms, listQualityPlans } from './dalux/forms.js';
import {
  createProject,
  getProject,
  listProjects,
  listProjectTemplates,
  listProjectUsers,
  listWorkPackages,
  updateProject,
} from './dalux/projects.js';
import { getTask, getTaskChanges, listTaskAttachments, listTasks } from './dalux/tasks.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export interface DaluxGatewayOptions extends DaluxClientOptions {}

const listProperties = {
  pageLink: { type: 'string' },
  maxPages: { type: 'number', minimum: 1, maximum: 25 },
} satisfies GatewayJsonObject;

const projectIdProperty = { type: 'string' } satisfies GatewayJsonObject;

export const daluxGatewayTools: GatewayToolDefinition[] = DALUX_CAPABILITIES.map(capability => ({
  name: capability.id.replace(/^dalux_/, ''),
  title: capability.title,
  description: capability.description,
  riskLevel: capability.risk === 'write' ? 'write' : 'read',
  enabledByDefault: capability.risk !== 'write',
  inputSchema: inputSchemaFor(capability.id),
}));

function inputSchemaFor(toolId: string): GatewayJsonObject {
  const objectSchema = (properties: GatewayJsonObject, required?: string[]): GatewayJsonObject => ({
    type: 'object',
    properties,
    ...(required?.length ? { required } : {}),
    additionalProperties: false,
  });

  switch (toolId) {
    case 'dalux_search_capabilities':
      return objectSchema({ query: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 50 } });
    case 'dalux_list_projects':
      return objectSchema({ includeTemplates: { type: 'boolean' }, ...listProperties });
    case 'dalux_get_project':
      return objectSchema({ projectId: projectIdProperty, includeMetadata: { type: 'boolean' } }, ['projectId']);
    case 'dalux_list_project_users':
      return objectSchema({ projectId: projectIdProperty, userId: { type: 'string' }, ...listProperties }, ['projectId']);
    case 'dalux_list_tasks':
      return objectSchema({ projectId: projectIdProperty, typeId: { type: 'string' }, ...listProperties }, ['projectId']);
    case 'dalux_get_task':
      return objectSchema({ projectId: projectIdProperty, taskId: { type: 'string' } }, ['projectId', 'taskId']);
    case 'dalux_get_task_changes':
    case 'dalux_list_task_attachments':
    case 'dalux_list_forms':
    case 'dalux_list_form_attachments':
    case 'dalux_list_work_packages':
      return objectSchema({ projectId: projectIdProperty, ...listProperties }, ['projectId']);
    case 'dalux_get_form':
      return objectSchema({ projectId: projectIdProperty, formId: { type: 'string' } }, ['projectId', 'formId']);
    case 'dalux_list_quality_plans':
      return objectSchema(
        {
          projectId: projectIdProperty,
          kind: { type: 'string', enum: ['inspection', 'test'] },
          part: { type: 'string', enum: ['plans', 'items', 'itemZones', 'registrations'] },
          ...listProperties,
        },
        ['projectId', 'kind'],
      );
    case 'dalux_list_file_areas':
      return objectSchema({ projectId: projectIdProperty, fileAreaId: { type: 'string' }, ...listProperties }, ['projectId']);
    case 'dalux_list_folders':
      return objectSchema(
        { projectId: projectIdProperty, fileAreaId: { type: 'string' }, folderId: { type: 'string' }, ...listProperties },
        ['projectId', 'fileAreaId'],
      );
    case 'dalux_list_files':
      return objectSchema(
        { projectId: projectIdProperty, fileAreaId: { type: 'string' }, fileId: { type: 'string' }, ...listProperties },
        ['projectId', 'fileAreaId'],
      );
    case 'dalux_list_version_sets':
      return objectSchema(
        {
          projectId: projectIdProperty,
          fileAreaId: { type: 'string' },
          versionSetId: { type: 'string' },
          includeFiles: { type: 'boolean' },
          ...listProperties,
        },
        ['projectId'],
      );
    case 'dalux_download_file':
      return objectSchema(
        {
          projectId: projectIdProperty,
          fileAreaId: { type: 'string' },
          fileId: { type: 'string' },
          fileRevisionId: { type: 'string' },
          maxBytes: { type: 'number', minimum: 1, maximum: 20971520 },
        },
        ['projectId', 'fileAreaId', 'fileId', 'fileRevisionId'],
      );
    case 'dalux_list_companies':
      return objectSchema({
        scope: { type: 'string', enum: ['project', 'catalog'] },
        projectId: { type: 'string' },
        companyId: { type: 'string' },
        ...listProperties,
      });
    case 'dalux_upload_file':
      return objectSchema(
        {
          projectId: projectIdProperty,
          fileAreaId: { type: 'string' },
          fileName: { type: 'string' },
          fileType: { type: 'string', enum: ['document', 'drawing', 'model'] },
          contentBase64: { type: 'string' },
          folderId: { type: 'string' },
          fileId: { type: 'string' },
          properties: { type: 'array', items: { type: 'object' } },
        },
        ['projectId', 'fileAreaId', 'fileName', 'contentBase64'],
      );
    case 'dalux_change_company':
      return objectSchema(
        {
          scope: { type: 'string', enum: ['project', 'catalog'] },
          action: { type: 'string', enum: ['create', 'update'] },
          projectId: { type: 'string' },
          companyId: { type: 'string' },
          body: { type: 'object' },
        },
        ['scope', 'action', 'body'],
      );
    case 'dalux_change_project':
      return objectSchema(
        {
          action: { type: 'string', enum: ['create', 'update'] },
          adminEmail: { type: 'string' },
          projectId: { type: 'string' },
          body: { type: 'object' },
          patch: { type: 'object' },
        },
        ['action'],
      );
    default:
      return objectSchema({});
  }
}

export function createDaluxGateway(options: DaluxGatewayOptions = {}) {
  const client = new DaluxClient(options);

  return {
    tools: daluxGatewayTools,
    async callTool(toolName: string, input: GatewayJsonObject = {}): Promise<GatewayToolResult> {
      // The borgels-mcp gateway validates input against inputSchema before
      // calling; the cast bridges its JSON types to the module signatures.
      const args = input as never;
      try {
        switch (toolName) {
          case 'search_capabilities':
            return jsonResult('Found Dalux capabilities.', searchCapabilities(String(input.query ?? ''), Number(input.limit ?? 20)));
          case 'list_projects':
            return jsonResult(
              'Listed projects.',
              input.includeTemplates ? await listProjectTemplates(client, args) : await listProjects(client, args),
            );
          case 'get_project':
            return jsonResult('Fetched project.', await getProject(client, args));
          case 'list_project_users':
            return jsonResult('Listed project users.', await listProjectUsers(client, args));
          case 'list_tasks':
            return jsonResult('Listed tasks.', await listTasks(client, args));
          case 'get_task':
            return jsonResult('Fetched task.', await getTask(client, args));
          case 'get_task_changes':
            return jsonResult('Fetched task changes.', await getTaskChanges(client, args));
          case 'list_task_attachments':
            return jsonResult('Listed task attachments.', await listTaskAttachments(client, args));
          case 'list_forms':
            return jsonResult('Listed forms.', await listForms(client, args));
          case 'get_form':
            return jsonResult('Fetched form.', await getForm(client, args));
          case 'list_form_attachments':
            return jsonResult('Listed form attachments.', await listFormAttachments(client, args));
          case 'list_quality_plans':
            return jsonResult('Listed quality plans.', await listQualityPlans(client, args));
          case 'list_work_packages':
            return jsonResult('Listed work packages.', await listWorkPackages(client, args));
          case 'list_file_areas':
            return jsonResult('Listed file areas.', await listFileAreas(client, args));
          case 'list_folders':
            return jsonResult('Listed folders.', await listFolders(client, args));
          case 'list_files':
            return jsonResult('Listed files.', await listFiles(client, args));
          case 'list_version_sets':
            return jsonResult('Listed version sets.', await listVersionSets(client, args));
          case 'download_file':
            return jsonResult('Downloaded file.', await downloadFile(client, args));
          case 'list_companies': {
            const scope = (input.scope as string) ?? 'project';
            if (scope === 'project') {
              return jsonResult('Listed project companies.', await listProjectCompanies(client, args));
            }
            return jsonResult(
              'Listed company catalog.',
              await listCompanyCatalog(client, {
                ...(input as object),
                catalogCompanyId: input.companyId as string | undefined,
              }),
            );
          }
          case 'upload_file':
            return jsonResult('Uploaded file.', await uploadFile(client, args));
          case 'change_company':
            return jsonResult('Changed company.', await changeCompany(client, args));
          case 'change_project': {
            if (input.action === 'create') {
              return jsonResult(
                'Created project.',
                await createProject(client, { adminEmail: String(input.adminEmail), body: (input.body ?? {}) as Record<string, unknown> }),
              );
            }
            return jsonResult(
              'Updated project.',
              await updateProject(client, { projectId: String(input.projectId), patch: (input.patch ?? {}) as Record<string, unknown> }),
            );
          }
          default:
            return errorResult(`Unsupported Dalux gateway tool: ${toolName}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
