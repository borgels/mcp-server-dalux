import { z } from 'zod/v4';
import type { DaluxClient } from './client.js';
import { fetchPages, type FetchPagesOptions, type PageResult } from './pagination.js';
import { assertWritesEnabled } from './policy.js';
import { encodePathParam } from '../path-params.js';
import { licenseSummary, rememberProjectModules } from './license.js';

/**
 * Request bodies for project writes, following the PostProject and
 * PatchProject schemas of the Dalux Build API (4.15). Dalux silently
 * ignores fields it does not document, so unknown fields are rejected here
 * to surface typos instead of reporting a no-op as success.
 *
 * The API documents a GET → edit → PATCH round trip, so the read-only
 * fields a GET returns (ids, timestamps, modules, metadata names and
 * reference values) are accepted and dropped before the request is sent.
 */
const readOnly = (what: string) => z.unknown().optional().describe(`Read-only (${what}); accepted and ignored.`);

export const metadataEntrySchema = z.strictObject({
  key: z.string().optional().describe('Metadata field key.'),
  name: readOnly('metadata field name'),
  values: z
    .array(
      z.strictObject({
        text: z.string().optional().describe('Value for text-type metadata.'),
        reference: z
          .strictObject({
            key: z.string().optional(),
            value: readOnly('reference display value'),
          })
          .optional()
          .describe('Reference key for list-type metadata.'),
      }),
    )
    .optional(),
});

export const postProjectSchema = z.strictObject({
  projectId: readOnly('ignored by Dalux on create'),
  projectName: z.string().optional(),
  address: z.string().optional(),
  number: z.string().optional(),
  type: z.enum(['building', 'infrastructure']).optional(),
  projectTemplateId: z.string().optional(),
  metadata: z.array(metadataEntrySchema).optional(),
});

export const patchProjectSchema = z.strictObject({
  projectId: readOnly('project id'),
  created: readOnly('creation time'),
  closing: readOnly('closing time'),
  modules: readOnly('enabled modules'),
  type: readOnly('project type; cannot be changed'),
  projectTemplateId: readOnly('template; cannot be changed'),
  projectName: z.string().optional(),
  address: z.string().optional(),
  number: z.string().optional(),
  metadata: z.array(metadataEntrySchema).optional(),
});

export type PostProject = z.infer<typeof postProjectSchema>;
export type PatchProject = z.infer<typeof patchProjectSchema>;
export type MetadataEntry = z.infer<typeof metadataEntrySchema>;

/** Drop the given read-only top-level keys and the read-only metadata fields. */
export function stripReadOnly(
  body: object,
  readOnlyKeys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || readOnlyKeys.includes(key)) {
      continue;
    }
    result[key] = key === 'metadata' && Array.isArray(value) ? (value as MetadataEntry[]).map(stripMetadataEntry) : value;
  }
  return result;
}

function stripMetadataEntry(entry: MetadataEntry): Record<string, unknown> {
  const { name: _name, values, ...rest } = entry;
  return {
    ...rest,
    ...(values === undefined
      ? {}
      : {
          values: values.map(({ reference, ...value }) => ({
            ...value,
            ...(reference === undefined ? {} : { reference: { key: reference.key } }),
          })),
        }),
  };
}

const POST_PROJECT_READ_ONLY = ['projectId'] as const;
const PATCH_PROJECT_READ_ONLY = ['projectId', 'created', 'closing', 'modules', 'type', 'projectTemplateId'] as const;

export interface ListOptions {
  pageLink?: string;
  maxPages?: number;
}

export async function listProjects(client: DaluxClient, options: ListOptions = {}): Promise<PageResult> {
  return fetchPages(client, '/5.1/projects', options);
}

export async function getProject(
  client: DaluxClient,
  input: { projectId: string; includeMetadata?: boolean },
): Promise<unknown> {
  const project = await client.get(`/5.0/projects/${encodePathParam(input.projectId, 'projectId')}`);
  const modules = rememberProjectModules(client, input.projectId, project);
  // Server-added compact view of the modules (Box/Field tier, restrictions),
  // next to the raw data. Never replaces a field Dalux returned.
  const summary = modules ? licenseSummary(modules) : undefined;
  if (!input.includeMetadata) {
    if (summary && project && typeof project === 'object' && !Array.isArray(project) && !('license' in project)) {
      return { ...project, license: summary };
    }
    return project;
  }

  const metadata = await client
    .get(`/1.0/projects/${encodePathParam(input.projectId, 'projectId')}/metadata`)
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));

  return { project, metadata, ...(summary ? { license: summary } : {}) };
}

export async function listProjectTemplates(client: DaluxClient, options: ListOptions = {}): Promise<PageResult> {
  return fetchPages(client, '/1.1/projectTemplates', options);
}

export async function listWorkPackages(
  client: DaluxClient,
  input: { projectId: string } & ListOptions,
): Promise<PageResult> {
  return fetchPages(client, `/1.0/projects/${encodePathParam(input.projectId, 'projectId')}/workpackages`, input);
}

export async function listProjectUsers(
  client: DaluxClient,
  input: { projectId: string; userId?: string } & ListOptions,
): Promise<unknown> {
  if (input.userId) {
    return client.get(
      `/1.1/projects/${encodePathParam(input.projectId, 'projectId')}/users/${encodePathParam(input.userId, 'userId')}`,
    );
  }
  return fetchPages(client, `/1.2/projects/${encodePathParam(input.projectId, 'projectId')}/users`, input);
}

export async function createProject(
  client: DaluxClient,
  input: { adminEmail: string; body: PostProject },
): Promise<unknown> {
  assertWritesEnabled('dalux_create_project');
  const body = stripReadOnly(parseBody(postProjectSchema, input.body, 'project create body'), POST_PROJECT_READ_ONLY);
  assertNotEmpty(body, 'project create body');
  return client.post('/5.0/projects', body, { adminEmail: input.adminEmail });
}

export async function updateProject(
  client: DaluxClient,
  input: { projectId: string; patch: PatchProject },
): Promise<unknown> {
  assertWritesEnabled('dalux_update_project');
  const patch = stripReadOnly(parseBody(patchProjectSchema, input.patch, 'project patch'), PATCH_PROJECT_READ_ONLY);
  assertNotEmpty(patch, 'project patch');
  return client.patch(`/5.0/projects/${encodePathParam(input.projectId, 'projectId')}`, patch);
}

/**
 * Reject a write that would send no writable field (and report a no-op as
 * success), including metadata entries left empty once read-only fields are
 * dropped.
 */
export function assertNotEmpty(body: Record<string, unknown>, label: string): void {
  if (Object.keys(body).length === 0) {
    throw new Error(`The ${label} contains no writable fields; nothing to send.`);
  }
  const metadata = body.metadata;
  if (Array.isArray(metadata) && metadata.some(entry => JSON.stringify(entry) === '{}')) {
    throw new Error(`The ${label} contains a metadata entry with no writable fields (key or values).`);
  }
}

export function parseBody<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid ${label}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
