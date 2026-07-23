import type { DaluxClient } from './client.js';
import { fetchPages, type PageResult } from './pagination.js';
import type { ListOptions } from './projects.js';
import { assertWritesEnabled } from './policy.js';

// KS files (drawings, scanned dossiers) can be large — the server should not be
// the bottleneck. Default is generous; the ceiling is bounded only so a single
// download can't exhaust the container (see mem_limit for mcp-dalux). Override
// DALUX_MAX_DOWNLOAD_BYTES on the instance to raise it further.
const DEFAULT_DOWNLOAD_CAP = 50 * 1024 * 1024;
const MAX_DOWNLOAD_CAP = Number(process.env.DALUX_MAX_DOWNLOAD_BYTES ?? 512 * 1024 * 1024);
/** Dalux caps upload parts at 104,857,600 bytes; we chunk well below that. */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

function projectPath(projectId: string, rest: string): string {
  return `/projects/${encodeURIComponent(projectId)}${rest}`;
}

export async function listFileAreas(
  client: DaluxClient,
  input: { projectId: string; fileAreaId?: string } & ListOptions,
): Promise<unknown> {
  if (input.fileAreaId) {
    return client.get(`/1.0${projectPath(input.projectId, `/file_areas/${encodeURIComponent(input.fileAreaId)}`)}`);
  }
  return fetchPages(client, `/5.1${projectPath(input.projectId, '/file_areas')}`, input);
}

export async function listFolders(
  client: DaluxClient,
  input: { projectId: string; fileAreaId: string; folderId?: string } & ListOptions,
): Promise<unknown> {
  const base = projectPath(input.projectId, `/file_areas/${encodeURIComponent(input.fileAreaId)}/folders`);
  if (input.folderId) {
    return client.get(`/5.0${base}/${encodeURIComponent(input.folderId)}`);
  }
  return fetchPages(client, `/5.1${base}`, input);
}

export async function listFiles(
  client: DaluxClient,
  input: { projectId: string; fileAreaId: string; fileId?: string } & ListOptions,
): Promise<unknown> {
  const base = projectPath(input.projectId, `/file_areas/${encodeURIComponent(input.fileAreaId)}/files`);
  if (input.fileId) {
    return client.get(`/5.0${base}/${encodeURIComponent(input.fileId)}`);
  }
  return fetchPages(client, `/6.1${base}`, input);
}

export async function listVersionSets(
  client: DaluxClient,
  input: { projectId: string; fileAreaId?: string; versionSetId?: string; includeFiles?: boolean } & ListOptions,
): Promise<unknown> {
  if (input.versionSetId) {
    const encoded = encodeURIComponent(input.versionSetId);
    if (input.includeFiles) {
      return fetchPages(client, `/3.0${projectPath(input.projectId, `/version_sets/${encoded}/files`)}`, input);
    }
    return client.get(`/2.0${projectPath(input.projectId, `/version_sets/${encoded}`)}`);
  }
  if (input.fileAreaId) {
    return fetchPages(
      client,
      `/2.1${projectPath(input.projectId, `/file_areas/${encodeURIComponent(input.fileAreaId)}/version_sets`)}`,
      input,
    );
  }
  return fetchPages(client, `/2.1${projectPath(input.projectId, '/version_sets')}`, input);
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
  const maxBytes = Math.min(input.maxBytes ?? DEFAULT_DOWNLOAD_CAP, MAX_DOWNLOAD_CAP);
  const path = `/2.0${projectPath(
    input.projectId,
    `/file_areas/${encodeURIComponent(input.fileAreaId)}/files/${encodeURIComponent(input.fileId)}/revisions/${encodeURIComponent(input.fileRevisionId)}/content`,
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
export async function uploadFile(client: DaluxClient, input: UploadFileInput): Promise<unknown> {
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

  const areaBase = projectPath(input.projectId, `/file_areas/${encodeURIComponent(input.fileAreaId)}`);

  const slot = await client.post<{ data?: { uploadGuid?: string }; uploadGuid?: string }>(
    `/1.0${areaBase}/upload`,
  );
  const uploadGuid = slot?.data?.uploadGuid ?? slot?.uploadGuid;
  if (!uploadGuid) {
    throw new Error(`Dalux did not return an uploadGuid: ${JSON.stringify(slot).slice(0, 300)}`);
  }

  for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, bytes.byteLength));
    await client.postBinary(`/1.0${areaBase}/upload/${encodeURIComponent(uploadGuid)}`, chunk);
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

  return client.post(`/2.0${areaBase}/upload/${encodeURIComponent(uploadGuid)}/finalize`, finalizeBody);
}
