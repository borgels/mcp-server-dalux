import type { DaluxClient } from './client.js';
import { fetchPages, type PageResult } from './pagination.js';
import type { ListOptions } from './projects.js';
import { encodePathParam } from '../path-params.js';

/**
 * Read-only property and metadata mappings (Dalux Build API 4.15): the
 * fields a file, project or catalog company can carry and their allowed
 * values. Useful before an upload with properties or a project/company
 * write with metadata.
 */
export type MappingScope = 'folder' | 'file' | 'project' | 'companyCatalog';

/** Scopes served by Box endpoints (Box Pro required). */
export const BOX_MAPPING_SCOPES: ReadonlySet<MappingScope> = new Set(['folder', 'file']);

export interface PropertyMappingsInput extends ListOptions {
  scope: MappingScope;
  projectId?: string;
  fileAreaId?: string;
  folderId?: string;
  fileId?: string;
  companyId?: string;
  /** Metadata key (project/companyCatalog) or file property id (folder/file): list its allowed values. */
  key?: string;
}

function required(value: string | undefined, name: string, scope: MappingScope): string {
  if (!value) {
    throw new Error(`${name} is required for scope=${scope}.`);
  }
  return value;
}

export function propertyMappingsPath(input: PropertyMappingsInput): string {
  const key = input.key ? encodePathParam(input.key, 'key') : undefined;
  switch (input.scope) {
    case 'folder':
    case 'file': {
      const area = `/projects/${encodePathParam(required(input.projectId, 'projectId', input.scope), 'projectId')}/file_areas/${encodePathParam(required(input.fileAreaId, 'fileAreaId', input.scope), 'fileAreaId')}`;
      if (key) {
        return `/1.0${area}/files/properties/1.0/mappings/${key}/values`;
      }
      if (input.scope === 'folder') {
        return `/1.1${area}/folders/${encodePathParam(required(input.folderId, 'folderId', input.scope), 'folderId')}/files/properties/1.0/mappings`;
      }
      return `/1.1${area}/files/${encodePathParam(required(input.fileId, 'fileId', input.scope), 'fileId')}/properties/1.0/mappings`;
    }
    case 'project': {
      const base = input.projectId
        ? `/1.0/projects/${encodePathParam(input.projectId, 'projectId')}/metadata/1.0/mappings`
        : '/1.0/projects/metadata/1.0/mappings';
      return key ? `${base}/${key}/values` : base;
    }
    case 'companyCatalog': {
      const base = input.companyId
        ? `/1.0/companyCatalog/${encodePathParam(input.companyId, 'companyId')}/metadata/1.0/mappings`
        : '/1.0/companyCatalog/metadata/1.0/mappings';
      return key ? `${base}/${key}/values` : base;
    }
    default:
      throw new Error(`Unknown mapping scope: ${String(input.scope)}`);
  }
}

export async function listPropertyMappings(client: DaluxClient, input: PropertyMappingsInput): Promise<PageResult> {
  return fetchPages(client, propertyMappingsPath(input), input);
}
