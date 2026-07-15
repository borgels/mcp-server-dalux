import type { DaluxClient } from './client.js';
import { fetchPages, type PageResult } from './pagination.js';
import type { ListOptions } from './projects.js';

export interface ListTasksInput extends ListOptions {
  projectId: string;
  /** Task type id; sent as OData $filter=data/type/typeId eq '<id>' (the only documented filter). */
  typeId?: string;
}

export async function listTasks(client: DaluxClient, input: ListTasksInput): Promise<PageResult> {
  return fetchPages(client, `/5.2/projects/${encodeURIComponent(input.projectId)}/tasks`, {
    pageLink: input.pageLink,
    maxPages: input.maxPages,
    query: input.typeId ? { $filter: `data/type/typeId eq '${escapeODataLiteral(input.typeId)}'` } : undefined,
  });
}

export async function getTask(
  client: DaluxClient,
  input: { projectId: string; taskId: string },
): Promise<unknown> {
  return client.get(
    `/3.4/projects/${encodeURIComponent(input.projectId)}/tasks/${encodeURIComponent(input.taskId)}`,
  );
}

export async function listTaskAttachments(
  client: DaluxClient,
  input: { projectId: string } & ListOptions,
): Promise<PageResult> {
  return fetchPages(client, `/1.1/projects/${encodeURIComponent(input.projectId)}/tasks/attachments`, input);
}

/** Incremental change feed for tasks/approvals/safety issues/observations/good practices. */
export async function getTaskChanges(
  client: DaluxClient,
  input: { projectId: string } & ListOptions,
): Promise<PageResult> {
  return fetchPages(client, `/2.3/projects/${encodeURIComponent(input.projectId)}/tasks/changes`, input);
}

function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
