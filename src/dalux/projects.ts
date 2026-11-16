import { z } from 'zod/v4';
import type { DaluxClient } from './client.js';
import { fetchPages, type FetchPagesOptions, type PageResult } from './pagination.js';
import { assertWritesEnabled } from './policy.js';
import { encodePathParam } from '../path-params.js';

/**
 * Request bodies for project writes, following the PostProject and
 * PatchProject schemas of the Dalux Build API (4.15). Dalux silently
 * ignores fields it does not document, so unknown fields are rejected here
 * to surface mistakes instead of reporting a no-op as success. Read-only
 * fields (projectId, metadata name, reference value) are left out.
 */
const shortText = (max: number) => z.string().max(max);

export const metadataEntrySchema = z
  .object({
    key: z.string().min(1).max(200).describe('Metadata field key.'),
    values: z
      .array(
        z
          .object({
            text: shortText(4000).optional().describe('Value for text-type metadata.'),
            reference: z
              .object({ key: z.string().min(1).max(200) })
              .strict()
              .optional()
              .describe('Reference key for list-type metadata.'),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const postProjectSchema = z
  .object({
    projectName: shortText(500).optional(),
    address: shortText(1000).optional(),
    number: shortText(200).optional(),
    type: z.enum(['building', 'infrastructure']).optional(),
    projectTemplateId: z.string().min(1).max(200).optional(),
    metadata: z.array(metadataEntrySchema).max(200).optional(),
  })
  .strict();

export const patchProjectSchema = z
  .object({
    projectName: shortText(500).optional(),
    address: shortText(1000).optional(),
    number: shortText(200).optional(),
    metadata: z.array(metadataEntrySchema).max(200).optional(),
  })
  .strict();

export type PostProject = z.infer<typeof postProjectSchema>;
export type PatchProject = z.infer<typeof patchProjectSchema>;

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
  if (!input.includeMetadata) {
    return project;
  }

  const metadata = await client
    .get(`/1.0/projects/${encodePathParam(input.projectId, 'projectId')}/metadata`)
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));

  return { project, metadata };
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
  const body = parseBody(postProjectSchema, input.body, 'project create body');
  return client.post('/5.0/projects', body, { adminEmail: input.adminEmail });
}

export async function updateProject(
  client: DaluxClient,
  input: { projectId: string; patch: PatchProject },
): Promise<unknown> {
  assertWritesEnabled('dalux_update_project');
  const patch = parseBody(patchProjectSchema, input.patch, 'project patch');
  return client.patch(`/5.0/projects/${encodePathParam(input.projectId, 'projectId')}`, patch);
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid ${label}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
