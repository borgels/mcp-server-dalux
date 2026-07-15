import type { DaluxClient } from './client.js';
import { fetchPages } from './pagination.js';
import type { ListOptions } from './projects.js';
import { assertWritesEnabled } from './policy.js';

export async function listProjectCompanies(
  client: DaluxClient,
  input: { projectId: string; companyId?: string } & ListOptions,
): Promise<unknown> {
  if (input.companyId) {
    return client.get(
      `/3.0/projects/${encodeURIComponent(input.projectId)}/companies/${encodeURIComponent(input.companyId)}`,
    );
  }
  return fetchPages(client, `/3.1/projects/${encodeURIComponent(input.projectId)}/companies`, input);
}

export async function listCompanyCatalog(
  client: DaluxClient,
  input: { catalogCompanyId?: string } & ListOptions = {},
): Promise<unknown> {
  if (input.catalogCompanyId) {
    return client.get(`/1.2/companyCatalog/${encodeURIComponent(input.catalogCompanyId)}`);
  }
  return fetchPages(client, '/2.2/companyCatalog', input);
}

export interface CompanyChangeInput {
  scope: 'project' | 'catalog';
  action: 'create' | 'update';
  projectId?: string;
  companyId?: string;
  body: Record<string, unknown>;
}

export async function changeCompany(client: DaluxClient, input: CompanyChangeInput): Promise<unknown> {
  assertWritesEnabled('dalux_change_company');

  if (input.scope === 'project') {
    if (!input.projectId) {
      throw new Error('projectId is required when scope is "project".');
    }
    const base = `/projects/${encodeURIComponent(input.projectId)}/companies`;
    if (input.action === 'create') {
      return client.post(`/3.1${base}`, input.body);
    }
    if (!input.companyId) {
      throw new Error('companyId is required when updating a project company.');
    }
    return client.patch(`/3.0${base}/${encodeURIComponent(input.companyId)}`, input.body);
  }

  if (input.action === 'create') {
    return client.post('/2.2/companyCatalog', input.body);
  }
  if (!input.companyId) {
    throw new Error('companyId is required when updating a catalog company.');
  }
  return client.patch(`/2.1/companyCatalog/${encodeURIComponent(input.companyId)}`, input.body);
}
