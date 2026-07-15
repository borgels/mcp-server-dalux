export type CapabilityRisk = 'read' | 'write';

export interface DaluxCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const PAGINATION_NOTE =
  'Lists are paginated with opaque links: pass the returned nextPage as pageLink to continue. Never construct page URLs yourself.';

export const DALUX_CAPABILITIES: DaluxCapability[] = [
  {
    id: 'dalux_search_capabilities',
    title: 'Search Dalux Capabilities',
    description: 'Find the Dalux MCP tool to use for projects, tasks, forms, quality plans, or Box documents.',
    risk: 'read',
    examples: [{ query: 'safety issues' }],
    identifierFormats: ['Tool id such as dalux_list_tasks or dalux_download_file.'],
    safetyNotes: ['Discovery only. Does not call Dalux.'],
    keywords: ['discover', 'search tools', 'help', 'capabilities'],
  },
  {
    id: 'dalux_list_projects',
    title: 'List Projects (Dalux)',
    description: 'List all projects the API identity can see, with name, type, address, number, and enabled modules.',
    risk: 'read',
    examples: [{}],
    identifierFormats: ['projectId (string, used by every other tool)'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['projects', 'list', 'byggesager', 'sager', 'overview'],
  },
  {
    id: 'dalux_get_project',
    title: 'Get Project (Dalux)',
    description: 'Fetch one project, optionally with its metadata fields (custom project-level data).',
    risk: 'read',
    examples: [{ projectId: '123456', includeMetadata: true }],
    identifierFormats: ['projectId from dalux_list_projects'],
    safetyNotes: [],
    keywords: ['project', 'details', 'metadata'],
  },
  {
    id: 'dalux_list_project_users',
    title: 'List Project Users (Dalux)',
    description: 'List the users on a project (or fetch one user by userId): name, email, company, user groups.',
    risk: 'read',
    examples: [{ projectId: '123456' }],
    identifierFormats: ['projectId', 'userId (optional, for a single user)'],
    safetyNotes: ['Read-only — the API cannot create or modify users.', PAGINATION_NOTE],
    keywords: ['users', 'members', 'people', 'medarbejdere', 'access'],
  },
  {
    id: 'dalux_list_tasks',
    title: 'List Tasks (Dalux Field)',
    description:
      'List tasks, approvals, safety issues, safety observations, and good practices on a project. Optional typeId filter. Each task carries subject, type, workflow state, location (building/level/room/drawing), and user-defined fields.',
    risk: 'read',
    examples: [{ projectId: '123456' }, { projectId: '123456', typeId: '177352982697' }],
    identifierFormats: ['projectId', 'typeId (task type id, from a task’s type.typeId)'],
    safetyNotes: [
      'The Dalux API is read-only for tasks — tasks cannot be created or updated through it.',
      PAGINATION_NOTE,
    ],
    keywords: ['tasks', 'opgaver', 'issues', 'safety', 'sikkerhed', 'approvals', 'tilsyn', 'mangler', 'field'],
  },
  {
    id: 'dalux_get_task',
    title: 'Get Task (Dalux Field)',
    description: 'Fetch one task with full details including location, workflow, and user-defined fields.',
    risk: 'read',
    examples: [{ projectId: '123456', taskId: '9876' }],
    identifierFormats: ['projectId', 'taskId from dalux_list_tasks'],
    safetyNotes: [],
    keywords: ['task', 'opgave', 'details', 'issue'],
  },
  {
    id: 'dalux_get_task_changes',
    title: 'Get Task Changes (Dalux Field)',
    description:
      'Incremental change feed for all tasks/approvals/safety items on a project. Use to detect what changed since a previous sync — Dalux has no webhooks, polling this feed is the supported pattern.',
    risk: 'read',
    examples: [{ projectId: '123456' }],
    identifierFormats: ['projectId', 'pageLink from a previous call to continue the stream'],
    safetyNotes: [
      'Incremental list: the stream end is signalled by nextPage == self; keep the last pageLink and poll it later for new changes.',
      'Items can reappear with newer state — the latest occurrence wins. Deletions come back with deleted=true.',
    ],
    keywords: ['changes', 'feed', 'sync', 'delta', 'poll', 'updates'],
  },
  {
    id: 'dalux_list_task_attachments',
    title: 'List Task Attachments (Dalux Field)',
    description: 'List attachments (photos, documents) across all tasks on a project, with media links.',
    risk: 'read',
    examples: [{ projectId: '123456' }],
    identifierFormats: ['projectId'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['attachments', 'photos', 'billeder', 'bilag', 'media', 'documentation'],
  },
  {
    id: 'dalux_list_forms',
    title: 'List Forms (Dalux Field)',
    description:
      'List registered forms/checklists (APV, kvalitetssikring, tilsynsnotater) on a project. Incremental list — reusable for syncs.',
    risk: 'read',
    examples: [{ projectId: '123456' }],
    identifierFormats: ['projectId'],
    safetyNotes: ['Read-only — forms cannot be created or filled through the API.', PAGINATION_NOTE],
    keywords: ['forms', 'checklists', 'skemaer', 'apv', 'kvalitetssikring', 'ks', 'registrations'],
  },
  {
    id: 'dalux_get_form',
    title: 'Get Form (Dalux Field)',
    description: 'Fetch one form with all its answered fields.',
    risk: 'read',
    examples: [{ projectId: '123456', formId: '555' }],
    identifierFormats: ['projectId', 'formId from dalux_list_forms'],
    safetyNotes: [],
    keywords: ['form', 'skema', 'answers', 'details'],
  },
  {
    id: 'dalux_list_form_attachments',
    title: 'List Form Attachments (Dalux Field)',
    description: 'List attachments across all forms on a project.',
    risk: 'read',
    examples: [{ projectId: '123456' }],
    identifierFormats: ['projectId'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['form attachments', 'photos', 'bilag'],
  },
  {
    id: 'dalux_list_quality_plans',
    title: 'List Inspection/Test Plans (Dalux Field)',
    description:
      'List quality assurance data: inspection plans (kontrolplaner) or test plans, and their items, item zones, or registrations. Select with kind (inspection|test) and part (plans|items|itemZones|registrations).',
    risk: 'read',
    examples: [
      { projectId: '123456', kind: 'inspection', part: 'plans' },
      { projectId: '123456', kind: 'test', part: 'registrations' },
    ],
    identifierFormats: ['projectId', 'kind: inspection | test', 'part: plans | items | itemZones | registrations'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['inspection', 'kontrolplan', 'test plan', 'quality', 'kvalitet', 'registrations', 'zones'],
  },
  {
    id: 'dalux_list_work_packages',
    title: 'List Work Packages (Dalux)',
    description: 'List work packages (arbejdspakker) on a project.',
    risk: 'read',
    examples: [{ projectId: '123456' }],
    identifierFormats: ['projectId'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['work packages', 'arbejdspakker', 'entrepriser'],
  },
  {
    id: 'dalux_list_file_areas',
    title: 'List File Areas (Dalux Box)',
    description: 'List the document file areas on a project (or fetch one by fileAreaId). Entry point for all Box document access.',
    risk: 'read',
    examples: [{ projectId: '123456' }],
    identifierFormats: ['projectId', 'fileAreaId (optional)'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['box', 'documents', 'dokumenter', 'file areas', 'filområder', 'cde'],
  },
  {
    id: 'dalux_list_folders',
    title: 'List Folders (Dalux Box)',
    description: 'List folders within a file area (or fetch one folder by folderId).',
    risk: 'read',
    examples: [{ projectId: '123456', fileAreaId: '42' }],
    identifierFormats: ['projectId', 'fileAreaId', 'folderId (optional)'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['folders', 'mapper', 'structure', 'box'],
  },
  {
    id: 'dalux_list_files',
    title: 'List Files (Dalux Box)',
    description:
      'List files within a file area (or fetch one file’s metadata by fileId): name, revision, properties, folder, deleted status. Incremental list — reusable for syncs.',
    risk: 'read',
    examples: [{ projectId: '123456', fileAreaId: '42' }],
    identifierFormats: ['projectId', 'fileAreaId', 'fileId (optional)'],
    safetyNotes: ['Returns metadata only — use dalux_download_file for content.', PAGINATION_NOTE],
    keywords: ['files', 'filer', 'documents', 'tegninger', 'drawings', 'revisions', 'metadata'],
  },
  {
    id: 'dalux_list_version_sets',
    title: 'List Version Sets (Dalux Box)',
    description: 'List version sets on a project or file area, one version set, or the files in a version set.',
    risk: 'read',
    examples: [{ projectId: '123456' }, { projectId: '123456', versionSetId: '7', includeFiles: true }],
    identifierFormats: ['projectId', 'fileAreaId (optional)', 'versionSetId (optional)'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['version sets', 'versionssæt', 'revisions', 'issue', 'udgivelser'],
  },
  {
    id: 'dalux_download_file',
    title: 'Download File (Dalux Box)',
    description:
      'Download the content of a specific file revision. Text-like content is returned as UTF-8, everything else base64. Capped at 2 MB by default (maxBytes up to 20 MB).',
    risk: 'read',
    examples: [{ projectId: '123456', fileAreaId: '42', fileId: '99', fileRevisionId: '3' }],
    identifierFormats: ['projectId, fileAreaId, fileId, fileRevisionId — all from dalux_list_files'],
    safetyNotes: ['Large drawings/models exceed the cap by design; fetch metadata first and confirm size with the user.'],
    keywords: ['download', 'content', 'hent', 'pdf', 'tegning', 'drawing', 'document'],
  },
  {
    id: 'dalux_list_companies',
    title: 'List Companies (Dalux)',
    description:
      'List companies on a project (scope=project, with projectId) or the account-wide company catalog (scope=catalog). Optionally fetch a single company by companyId.',
    risk: 'read',
    examples: [
      { scope: 'project', projectId: '123456' },
      { scope: 'catalog' },
    ],
    identifierFormats: ['scope: project | catalog', 'projectId (project scope)', 'companyId (optional)'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['companies', 'virksomheder', 'firmaer', 'catalog', 'underentreprenører', 'subcontractors'],
  },
  {
    id: 'dalux_upload_file',
    title: 'Upload File (Dalux Box)',
    description:
      'Upload a document to a file area: a new file into a folder (folderId) or a new revision of an existing file (fileId). Handles Dalux’ 3-step chunked upload flow. Requires write access on this instance.',
    risk: 'write',
    examples: [
      { projectId: '123456', fileAreaId: '42', folderId: '7', fileName: 'miljorapport.pdf', fileType: 'document', contentBase64: '…' },
    ],
    identifierFormats: ['fileType: document | drawing | model', 'content as base64'],
    safetyNotes: [
      'Requires DALUX_ENABLE_WRITES=true on the server.',
      'File areas of type "published" or "shared" cannot be uploaded to.',
      'Uploads are visible to everyone with access to the file area — confirm the target folder with the user.',
    ],
    keywords: ['upload', 'attach', 'document', 'apv', 'rapport', 'bilag', 'write'],
  },
  {
    id: 'dalux_change_company',
    title: 'Create/Update Company (Dalux)',
    description:
      'Add a company to a project or the account catalog, or update one. Requires write access on this instance.',
    risk: 'write',
    examples: [{ scope: 'project', action: 'create', projectId: '123456', body: { name: 'Ny UE ApS' } }],
    identifierFormats: ['scope: project | catalog', 'action: create | update'],
    safetyNotes: ['Requires DALUX_ENABLE_WRITES=true on the server.'],
    keywords: ['company', 'create', 'update', 'virksomhed', 'underentreprenør', 'write'],
  },
  {
    id: 'dalux_change_project',
    title: 'Create/Update Project (Dalux)',
    description:
      'Create a new project (applies the company’s default Field/Box configuration; requires adminEmail) or update an existing one. Requires write access on this instance.',
    risk: 'write',
    examples: [
      { action: 'create', adminEmail: 'admin@example.com', body: { projectName: 'Nedrivning Xvej 1', type: 'building' } },
      { action: 'update', projectId: '123456', patch: { projectName: 'Nyt navn' } },
    ],
    identifierFormats: ['action: create | update'],
    safetyNotes: [
      'Requires DALUX_ENABLE_WRITES=true on the server.',
      'Project creation may consume a project license — confirm with the user first.',
    ],
    keywords: ['project', 'create', 'opret', 'byggesag', 'update', 'write'],
  },
];

export function searchCapabilities(query: string, limit = 20): DaluxCapability[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return DALUX_CAPABILITIES.slice(0, limit);
  }

  return DALUX_CAPABILITIES.map(capability => ({
    capability,
    score: scoreCapability(capability, normalized),
  }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: DaluxCapability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    ...capability.identifierFormats,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();

  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
