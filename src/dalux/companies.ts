import { z } from 'zod/v4';
import type { DaluxClient } from './client.js';
import { fetchPages } from './pagination.js';
import { assertNotEmpty, metadataEntrySchema, parseBody, stripReadOnly, type ListOptions } from './projects.js';
import { assertWritesEnabled } from './policy.js';
import { encodePathParam } from '../path-params.js';

export async function listProjectCompanies(
  client: DaluxClient,
  input: { projectId: string; companyId?: string } & ListOptions,
): Promise<unknown> {
  if (input.companyId) {
    return client.get(
      `/3.0/projects/${encodePathParam(input.projectId, 'projectId')}/companies/${encodePathParam(input.companyId, 'companyId')}`,
    );
  }
  return fetchPages(client, `/3.1/projects/${encodePathParam(input.projectId, 'projectId')}/companies`, input);
}

export async function listCompanyCatalog(
  client: DaluxClient,
  input: { catalogCompanyId?: string } & ListOptions = {},
): Promise<unknown> {
  if (input.catalogCompanyId) {
    return client.get(`/1.2/companyCatalog/${encodePathParam(input.catalogCompanyId, 'catalogCompanyId')}`);
  }
  return fetchPages(client, '/2.2/companyCatalog', input);
}

/**
 * Request bodies for company writes, following ProjectCompany and
 * Post/PatchCatalogueCompany of the Dalux Build API (4.15). Unknown fields
 * are rejected (Dalux ignores them silently). Read-only ids returned by a
 * GET (companyId; catalogCompanyId on catalog companies) are accepted and
 * dropped, so a fetched object can be edited and sent back.
 */
const readOnly = (what: string) => z.unknown().optional().describe(`Read-only (${what}); accepted and ignored.`);

export const projectCompanySchema = z.strictObject({
  companyId: readOnly('project company id'),
  catalogCompanyId: z
    .string()
    .optional()
    .describe('Link to a catalog company; imports its name, vatNumber and address.'),
  name: z.string().optional(),
  vatNumber: z.string().optional(),
  address: z.string().optional(),
});

export const catalogCompanySchema = z.strictObject({
  catalogCompanyId: readOnly('catalog company id'),
  name: z.string().optional(),
  vatNumber: z.string().optional(),
  address: z.string().optional(),
  website: z.string().optional(),
  description: z.string().optional(),
  zipCode: z.string().optional(),
  city: z.string().optional(),
  phoneNumber: z.string().optional(),
  email: z.string().optional(),
  metadata: z.array(metadataEntrySchema).optional(),
});

/**
 * Tool-level body: the union of the fields of both scopes, so a typo is
 * reported by name. changeCompany then checks the body against the schema
 * of the requested scope.
 */
export const companyBodyInputSchema = z
  .strictObject({
    companyId: readOnly('project company id'),
    catalogCompanyId: z
      .string()
      .optional()
      .describe('scope=project: link to a catalog company. scope=catalog: read-only, ignored.'),
    name: z.string().optional(),
    vatNumber: z.string().optional(),
    address: z.string().optional(),
    website: z.string().optional().describe('scope=catalog only.'),
    description: z.string().optional().describe('scope=catalog only.'),
    zipCode: z.string().optional().describe('scope=catalog only.'),
    city: z.string().optional().describe('scope=catalog only.'),
    phoneNumber: z.string().optional().describe('scope=catalog only.'),
    email: z.string().optional().describe('scope=catalog only.'),
    metadata: z.array(metadataEntrySchema).optional().describe('scope=catalog only.'),
  })
  .describe(
    'scope=project: catalogCompanyId, name, vatNumber, address. scope=catalog: name, vatNumber, address, website, description, zipCode, city, phoneNumber, email, metadata.',
  );

export type ProjectCompanyBody = z.infer<typeof projectCompanySchema>;
export type CatalogCompanyBody = z.infer<typeof catalogCompanySchema>;
export type CompanyBodyInput = z.infer<typeof companyBodyInputSchema>;

export interface CompanyChangeInput {
  scope: 'project' | 'catalog';
  action: 'create' | 'update';
  projectId?: string;
  companyId?: string;
  body: CompanyBodyInput;
}

export async function changeCompany(client: DaluxClient, input: CompanyChangeInput): Promise<unknown> {
  assertWritesEnabled('dalux_change_company');

  if (input.scope === 'project') {
    if (!input.projectId) {
      throw new Error('projectId is required when scope is "project".');
    }
    const body = stripReadOnly(parseBody(projectCompanySchema, input.body, 'project company body'), ['companyId']);
    const base = `/projects/${encodePathParam(input.projectId, 'projectId')}/companies`;
    if (input.action === 'create') {
      return client.post(`/3.1${base}`, body);
    }
    if (!input.companyId) {
      throw new Error('companyId is required when updating a project company.');
    }
    assertNotEmpty(body, 'project company body');
    return client.patch(`/3.0${base}/${encodePathParam(input.companyId, 'companyId')}`, body);
  }

  const body = stripReadOnly(parseBody(catalogCompanySchema, input.body, 'catalog company body'), ['catalogCompanyId']);
  if (input.action === 'create') {
    return client.post('/2.2/companyCatalog', body);
  }
  if (!input.companyId) {
    throw new Error('companyId is required when updating a catalog company.');
  }
  assertNotEmpty(body, 'catalog company body');
  return client.patch(`/2.1/companyCatalog/${encodePathParam(input.companyId, 'companyId')}`, body);
}
