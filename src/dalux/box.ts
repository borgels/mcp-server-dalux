import type { DaluxClient } from './client.js';
import { fetchPages, type PageResult } from './pagination.js';
import type { ListOptions } from './projects.js';
import { assertWritesEnabled } from './policy.js';
import { requireBoxPro } from './license.js';
import { encodePathParam } from '../path-params.js';

export { DEFAULT_DOWNLOAD_CEILING, MAX_DOWNLOAD_BYTES_PARAM } from './client.js';

// Downloaded content is returned inline (UTF-8 or base64) to the model, so the
// limits are sized for that rather than for bulk transfer. Callers may raise
// maxBytes up to the server ceiling (DaluxClient.maxDownloadBytes, set by
// DALUX_MAX_DOWNLOAD_BYTES).
export const DEFAULT_DOWNLOAD_CAP = 10 * 1024 * 1024;
/** Dalux caps upload parts at 104,857,600 bytes; we chunk well below that. */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

function projectPath(projectId: string, rest: string): string {
  return `/projects/${encodePathParam(projectId, 'projectId')}${rest}`;
}

export async function listFileAreas(
  client: DaluxClient,
  input: { projectId: string; fileAreaId?: string } & ListOptions,
): Promise<unknown> {
  if (input.fileAreaId) {
    return client.get(`/1.0${projectPath(input.projectId, `/file_areas/${encodePathParam(input.fileAreaId, 'fileAreaId')}`)}`);
  }
  return fetchPages(client, `/5.1${projectPath(input.projectId, '/file_areas')}`, input);
}

export async function listFolders(
  client: DaluxClient,
  input: { projectId: string; fileAreaId: string; folderId?: string } & ListOptions,
): Promise<unknown> {
  const base = projectPath(input.projectId, `/file_areas/${encodePathParam(input.fileAreaId, 'fileAreaId')}/folders`);
  if (input.folderId) {
    return client.get(`/5.0${base}/${encodePathParam(input.folderId, 'folderId')}`);
  }
  return fetchPages(client, `/5.1${base}`, input);
}

export async function listFiles(
  client: DaluxClient,
  input: { projectId: string; fileAreaId: string; fileId?: string; includeProperties?: boolean } & ListOptions,
): Promise<unknown> {
  const base = projectPath(input.projectId, `/file_areas/${encodePathParam(input.fileAreaId, 'fileAreaId')}/files`);
  if (input.fileId) {
    return client.get(`/5.0${base}/${encodePathParam(input.fileId, 'fileId')}`);
  }
  return fetchPages(client, `/6.1${base}`, { ...input, query: propertiesQuery(input.includeProperties) });
}

export async function listVersionSets(
  client: DaluxClient,
  input: {
    projectId: string;
    fileAreaId?: string;
    versionSetId?: string;
    includeFiles?: boolean;
    includeProperties?: boolean;
  } & ListOptions,
): Promise<unknown> {
  if (input.versionSetId) {
    const encoded = encodePathParam(input.versionSetId, 'versionSetId');
    if (input.includeFiles) {
      return fetchPages(client, `/3.0${projectPath(input.projectId, `/version_sets/${encoded}/files`)}`, {
        ...input,
        query: propertiesQuery(input.includeProperties),
      });
    }
    return client.get(`/2.0${projectPath(input.projectId, `/version_sets/${encoded}`)}`);
  }
  if (input.fileAreaId) {
    return fetchPages(
      client,
      `/2.1${projectPath(input.projectId, `/file_areas/${encodePathParam(input.fileAreaId, 'fileAreaId')}/version_sets`)}`,
      input,
    );
  }
  return fetchPages(client, `/2.1${projectPath(input.projectId, '/version_sets')}`, input);
}

/** `includeProperties=true` on file lists (only sent when requested). */
function propertiesQuery(includeProperties: boolean | undefined): Record<string, boolean> | undefined {
  return includeProperties ? { includeProperties: true } : undefined;
}

export interface DownloadFileInput {
  projectId: string;
  fileAreaId: string;
  fileId: string;
  fileRevisionId: string;
  maxBytes?: number;
}

export async function downloadFile(client: DaluxClient, input: DownloadFileInput): Promise<{
  contentType: string;
  sizeBytes: number;
  encoding: 'utf-8' | 'base64';
  content: string;
}> {
  const maxBytes = Math.min(input.maxBytes ?? DEFAULT_DOWNLOAD_CAP, client.maxDownloadBytes);
  const path = `/2.0${projectPath(
    input.projectId,
    `/file_areas/${encodePathParam(input.fileAreaId, 'fileAreaId')}/files/${encodePathParam(input.fileId, 'fileId')}/revisions/${encodePathParam(input.fileRevisionId, 'fileRevisionId')}/content`,
  )}`;

  const { bytes, contentType } = await client.getBinary(path, maxBytes);
  const isText = /^(text\/|application\/(json|xml|csv))/.test(contentType);

  return {
    contentType,
    sizeBytes: bytes.byteLength,
    encoding: isText ? 'utf-8' : 'base64',
    content: isText ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64'),
  };
}

export interface UploadFileInput {
  projectId: string;
  fileAreaId: string;
  fileName: string;
  fileType: 'document' | 'drawing' | 'model';
  contentBase64: string;
  /** Upload a new revision of an existing file… */
  fileId?: string;
  /** …or a new file into this folder. Exactly one of fileId/folderId is required. */
  folderId?: string;
  properties?: Array<Record<string, unknown>>;
}

/**
 * Dalux uploads are a 3-step flow: reserve an upload slot, POST the byte
 * parts, then finalize with file metadata. File areas of type "published"
 * or "shared" cannot be uploaded to.
 */
export async function uploadFile(
  client: DaluxClient,
  input: UploadFileInput,
  options: { chunkBytes?: number } = {},
): Promise<unknown> {
  assertWritesEnabled('dalux_upload_file');

  if (!input.fileId && !input.folderId) {
    throw new Error('Provide folderId (new file) or fileId (new revision of an existing file).');
  }
  if (input.fileId && input.folderId) {
    throw new Error('Provide either folderId or fileId, not both.');
  }

  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.byteLength === 0) {
    throw new Error('contentBase64 decoded to 0 bytes.');
  }

  // Build the part header before reserving an upload slot, so an unusable
  // file name fails without leaving an orphaned slot behind.
  const contentDisposition = uploadContentDisposition(input.fileName);
  const areaBase = projectPath(input.projectId, `/file_areas/${encodePathParam(input.fileAreaId, 'fileAreaId')}`);
  await requireBoxPro(client, input.projectId);

  const slot = await client.post<{ data?: { uploadGuid?: string }; uploadGuid?: string }>(
    `/1.0${areaBase}/upload`,
  );
  const uploadGuid = slot?.data?.uploadGuid ?? slot?.uploadGuid;
  if (!uploadGuid) {
    // Dalux's answer is not quoted: it is Dalux's text.
    throw new Error('Dalux did not return an uploadGuid for the upload.');
  }

  const chunkBytes = options.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  const total = bytes.byteLength;
  const partPath = `/1.0${areaBase}/upload/${encodePathParam(uploadGuid, 'uploadGuid')}`;
  for (let offset = 0; offset < total; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, total);
    await client.postBinary(partPath, bytes.subarray(offset, end), {
      'Content-Disposition': contentDisposition,
      'Content-Range': `bytes ${offset}-${end - 1}/${total}`,
    });
  }

  const finalizeBody: Record<string, unknown> = {
    fileName: input.fileName,
    fileType: input.fileType,
  };
  if (input.fileId) {
    finalizeBody.fileId = input.fileId;
  }
  if (input.folderId) {
    finalizeBody.folderId = input.folderId;
  }
  if (input.properties?.length) {
    finalizeBody.properties = input.properties;
  }

  return client.post(`/2.0${areaBase}/upload/${encodePathParam(uploadGuid, 'uploadGuid')}/finalize`, finalizeBody);
}

/**
 * Content-Disposition for an upload part: an ASCII-only `filename` fallback
 * plus the RFC 5987 `filename*` with the UTF-8 name percent-encoded. The
 * fallback is a quoted string in which non-printable and non-ASCII
 * characters, quotes, backslashes and percent signs become `_`; the exact
 * name travels in `filename*` and in the finalize request.
 */
export function uploadContentDisposition(fileName: string): string {
  let encoded: string;
  try {
    encoded = encodeURIComponent(fileName);
  } catch {
    throw new Error('fileName is not valid Unicode text (it contains an unpaired surrogate).');
  }
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  encoded = encoded.replace(
    /['()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `form-data; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
