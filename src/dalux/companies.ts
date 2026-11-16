import { z } from 'zod/v4';
import type { DaluxClient } from './client.js';
import { fetchPages } from './pagination.js';
import { metadataEntrySchema, type ListOptions } from './projects.js';
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
 * are rejected (Dalux ignores them silently); read-only ids are left out.
 */
export const projectCompanySchema = z
  .object({
    catalogCompanyId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Link to a catalog company; imports its name, vatNumber and address.'),
    name: z.string().max(500).optional(),
    vatNumber: z.string().max(100).optional(),
    address: z.string().max(1000).optional(),
  })
  .strict();

export const catalogCompanySchema = z
  .object({
    name: z.string().max(500).optional(),
    vatNumber: z.string().max(100).optional(),
    address: z.string().max(1000).optional(),
    website: z.string().max(1000).optional(),
    description: z.string().max(4000).optional(),
    zipCode: z.string().max(50).optional(),
    city: z.string().max(200).optional(),
    phoneNumber: z.string().max(100).optional(),
    email: z.string().max(320).optional(),
    metadata: z.array(metadataEntrySchema).max(200).optional(),
  })
  .strict();

export type ProjectCompanyBody = z.infer<typeof projectCompanySchema>;
export type CatalogCompanyBody = z.infer<typeof catalogCompanySchema>;

export interface CompanyChangeInput {
  scope: 'project' | 'catalog';
  action: 'create' | 'update';
  projectId?: string;
  companyId?: string;
  body: ProjectCompanyBody | CatalogCompanyBody;
}

/** The body schema that applies to a company write in the given scope. */
export function companyBodySchema(scope: 'project' | 'catalog') {
  return scope === 'project' ? projectCompanySchema : catalogCompanySchema;
}

export async function changeCompany(client: DaluxClient, input: CompanyChangeInput): Promise<unknown> {
  assertWritesEnabled('dalux_change_company');
  const parsed = companyBodySchema(input.scope).safeParse(input.body);
  if (!parsed.success) {
    throw new Error(`Invalid ${input.scope} company body: ${z.prettifyError(parsed.error)}`);
  }
  const body = parsed.data;

  if (input.scope === 'project') {
    if (!input.projectId) {
      throw new Error('projectId is required when scope is "project".');
    }
    const base = `/projects/${encodePathParam(input.projectId, 'projectId')}/companies`;
    if (input.action === 'create') {
      return client.post(`/3.1${base}`, body);
    }
    if (!input.companyId) {
      throw new Error('companyId is required when updating a project company.');
    }
    return client.patch(`/3.0${base}/${encodePathParam(input.companyId, 'companyId')}`, body);
  }

  if (input.action === 'create') {
    return client.post('/2.2/companyCatalog', body);
  }
  if (!input.companyId) {
    throw new Error('companyId is required when updating a catalog company.');
  }
  return client.patch(`/2.1/companyCatalog/${encodePathParam(input.companyId, 'companyId')}`, body);
}
