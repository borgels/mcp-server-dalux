import type { DaluxClient } from './client.js';
import { DaluxHttpError } from '../errors.js';
import { fetchPages, type PageResult } from './pagination.js';
import type { ListOptions } from './projects.js';
import { encodePathParam } from '../path-params.js';

export interface ListTasksInput extends ListOptions {
  projectId: string;
  /** Task type id; sent as OData $filter=data/type/typeId eq '<id>' (the only documented filter). */
  typeId?: string;
}

export async function listTasks(client: DaluxClient, input: ListTasksInput): Promise<PageResult> {
  return fetchPages(client, `/5.2/projects/${encodePathParam(input.projectId, 'projectId')}/tasks`, {
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
    `/3.4/projects/${encodePathParam(input.projectId, 'projectId')}/tasks/${encodePathParam(input.taskId, 'taskId')}`,
  );
}

export async function listTaskAttachments(
  client: DaluxClient,
  input: { projectId: string } & ListOptions,
): Promise<PageResult> {
  return fetchPages(client, `/1.1/projects/${encodePathParam(input.projectId, 'projectId')}/tasks/attachments`, input);
}

/**
 * Change feed for tasks/approvals/safety issues/observations/good practices.
 * Callers keep the returned nextPage and pass it back as pageLink to continue.
 *
 * Dalux answers 404 "No task changes on project" on a project without any
 * changes; that is returned as an empty page rather than an error.
 */
export async function getTaskChanges(
  client: DaluxClient,
  input: { projectId: string } & ListOptions,
): Promise<PageResult & { note?: string }> {
  try {
    return await fetchPages(client, `/2.3/projects/${encodePathParam(input.projectId, 'projectId')}/tasks/changes`, input);
  } catch (error) {
    if (isNoTaskChanges(error)) {
      return {
        items: [],
        pagesFetched: 1,
        // Keep the caller's cursor so a poller does not restart the feed.
        nextPage: input.pageLink,
        endOfIncrementalStream: false,
        note: 'Dalux reports no task changes on this project.',
      };
    }
    throw error;
  }
}

/** HTTP 404 whose Dalux message is exactly "No task changes on project". */
export function isNoTaskChanges(error: unknown): boolean {
  if (!(error instanceof DaluxHttpError) || error.status !== 404) {
    return false;
  }
  const payload = (error.payload && typeof error.payload === 'object' ? error.payload : {}) as Record<string, unknown>;
  return typeof payload.message === 'string' && /^no task changes on project\.?$/i.test(payload.message.trim());
}

function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
