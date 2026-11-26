import type { DaluxClient, DaluxStream } from './client.js';
import { requireBoxPro } from './license.js';
import { encodePathParam } from '../path-params.js';

/**
 * Short-lived file links (dalux_get_file_link and the gateway's openFile).
 *
 * The Dalux Build API has no link a person can open: a file's
 * `downloadLink` needs the API key in a header. An embedding host that wants
 * a person to get a file without the bytes passing through the conversation
 * hands out a link of its own (the `fileLinks` hook) and, when the link is
 * opened, streams the file from Dalux through the gateway (`openFile`). The
 * host gets ids only; the file's name and size are read from Dalux again
 * when the file is opened, so the host keeps nothing of Dalux's data.
 */

/** The file a host is asked to make a link for: ids only, all checked against Dalux first. */
export interface FileLinkRequest {
  projectId: string;
  fileAreaId: string;
  fileId: string;
  fileRevisionId: string;
}

/** The host's link: an absolute https URL and when it stops working (ISO 8601). */
export interface FileLinkResult {
  url: string;
  expiresAt: string;
}

/** Embedding-host hook: make a short-lived link that opens the file through the host. */
export type FileLinks = (file: FileLinkRequest) => Promise<FileLinkResult>;

/** The refusal under a host's policy without a hook. */
export const FILE_LINK_UNAVAILABLE_HOSTED_MESSAGE =
  'dalux_get_file_link is not available on this instance: the embedding host has not given a way to hand out file links (fileLinks).';

/** The refusal on the standalone server, which has no link of its own. */
export const FILE_LINK_UNAVAILABLE_MESSAGE =
  'dalux_get_file_link is not available on this server: file links are given only by an embedding host. Use dalux_download_file for the content.';

export const FILE_DELETED_MESSAGE = 'The file is deleted in Dalux, so it cannot be opened.';
export const FILE_LINK_REFUSED_MESSAGE = 'The embedding host did not give a usable link for the file.';

export interface FileRef {
  projectId: string;
  fileAreaId: string;
  fileId: string;
  fileRevisionId?: string;
}

/** The file's metadata as Dalux gives it (only the fields used here). */
interface FileMetadata {
  fileRevisionId?: unknown;
  fileName?: unknown;
  fileSize?: unknown;
  fileType?: unknown;
  deleted?: unknown;
}

function filePath(input: { projectId: string; fileAreaId: string; fileId: string }): string {
  return `/projects/${encodePathParam(input.projectId, 'projectId')}/file_areas/${encodePathParam(input.fileAreaId, 'fileAreaId')}/files/${encodePathParam(input.fileId, 'fileId')}`;
}

async function fileMetadata(client: DaluxClient, input: FileRef): Promise<FileMetadata> {
  const answer = await client.get<{ data?: FileMetadata } | FileMetadata | null>(`/5.0${filePath(input)}`);
  const record = answer && typeof answer === 'object' ? answer : {};
  const data = 'data' in record && record.data && typeof record.data === 'object' ? record.data : record;
  return data as FileMetadata;
}

function idText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

/** A plain file name for a download: no path, no control characters, at most 200 characters. */
function downloadName(value: unknown, fileId: string): string {
  const text = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 200);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? `dalux-file-${fileId}` : cleaned;
}

/** The revision asked for, or the file's current one. */
function revisionOf(input: FileRef, metadata: FileMetadata): string {
  const revision = input.fileRevisionId ?? idText(metadata.fileRevisionId);
  if (revision === undefined) {
    throw new Error('Dalux gave no revision for the file; pass fileRevisionId from dalux_list_files.');
  }
  return revision;
}

/**
 * dalux_get_file_link: check the file in Dalux (Box Pro, it exists, it is not
 * deleted), then ask the host for a link to it. The link is the host's, with
 * the file's name, size and revision from Dalux.
 */
export async function getFileLink(client: DaluxClient, input: FileRef, links: FileLinks): Promise<Record<string, unknown>> {
  await requireBoxPro(client, input.projectId);
  const metadata = await fileMetadata(client, input);
  if (metadata.deleted === true) throw new Error(FILE_DELETED_MESSAGE);
  const fileRevisionId = revisionOf(input, metadata);
  const request: FileLinkRequest = {
    projectId: input.projectId,
    fileAreaId: input.fileAreaId,
    fileId: input.fileId,
    fileRevisionId,
  };
  const link = await links({ ...request });
  if (!link || typeof link.url !== 'string' || !/^https:\/\//.test(link.url) || typeof link.expiresAt !== 'string') {
    throw new Error(FILE_LINK_REFUSED_MESSAGE);
  }
  return {
    url: link.url,
    expiresAt: link.expiresAt,
    fileName: typeof metadata.fileName === 'string' ? metadata.fileName : null,
    fileSize: typeof metadata.fileSize === 'number' ? metadata.fileSize : null,
    fileType: typeof metadata.fileType === 'string' ? metadata.fileType : null,
    ...request,
  };
}

/** A file opened for streaming: the body and the name and type to give it. */
export interface OpenedFile extends DaluxStream {
  fileName: string;
}

/**
 * Open one file revision as a stream (the gateway's openFile). The file's
 * metadata is read again, so a file deleted since the link was made is
 * refused and the download name is Dalux's current one.
 */
export async function openFile(client: DaluxClient, input: FileRef): Promise<OpenedFile> {
  await requireBoxPro(client, input.projectId);
  const metadata = await fileMetadata(client, input);
  if (metadata.deleted === true) throw new Error(FILE_DELETED_MESSAGE);
  const fileRevisionId = revisionOf(input, metadata);
  const stream = await client.openStream(
    `/2.0${filePath(input)}/revisions/${encodePathParam(fileRevisionId, 'fileRevisionId')}/content`,
  );
  return { ...stream, fileName: downloadName(metadata.fileName, input.fileId) };
}
