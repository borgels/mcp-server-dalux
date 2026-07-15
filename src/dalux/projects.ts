import type { DaluxClient } from './client.js';
import { fetchPages, type FetchPagesOptions, type PageResult } from './pagination.js';
import { assertWritesEnabled } from './policy.js';

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
  const project = await client.get(`/5.0/projects/${encodeURIComponent(input.projectId)}`);
  if (!input.includeMetadata) {
    return project;
  }

  const metadata = await client
    .get(`/1.0/projects/${encodeURIComponent(input.projectId)}/metadata`)
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
  return fetchPages(client, `/1.0/projects/${encodeURIComponent(input.projectId)}/workpackages`, input);
}

export async function listProjectUsers(
  client: DaluxClient,
  input: { projectId: string; userId?: string } & ListOptions,
): Promise<unknown> {
  if (input.userId) {
    return client.get(
      `/1.1/projects/${encodeURIComponent(input.projectId)}/users/${encodeURIComponent(input.userId)}`,
    );
  }
  return fetchPages(client, `/1.2/projects/${encodeURIComponent(input.projectId)}/users`, input);
}

export async function createProject(
  client: DaluxClient,
  input: { adminEmail: string; body: Record<string, unknown> },
): Promise<unknown> {
  assertWritesEnabled('dalux_create_project');
  return client.post('/5.0/projects', input.body, { adminEmail: input.adminEmail });
}

export async function updateProject(
  client: DaluxClient,
  input: { projectId: string; patch: Record<string, unknown> },
): Promise<unknown> {
  assertWritesEnabled('dalux_update_project');
  return client.patch(`/5.0/projects/${encodeURIComponent(input.projectId)}`, input.patch);
}
