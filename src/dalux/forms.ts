import type { DaluxClient } from './client.js';
import { fetchPages, type PageResult } from './pagination.js';
import type { ListOptions } from './projects.js';

export async function listForms(
  client: DaluxClient,
  input: { projectId: string } & ListOptions,
): Promise<PageResult> {
  return fetchPages(client, `/2.2/projects/${encodeURIComponent(input.projectId)}/forms`, input);
}

export async function getForm(
  client: DaluxClient,
  input: { projectId: string; formId: string },
): Promise<unknown> {
  return client.get(
    `/1.3/projects/${encodeURIComponent(input.projectId)}/forms/${encodeURIComponent(input.formId)}`,
  );
}

export async function listFormAttachments(
  client: DaluxClient,
  input: { projectId: string } & ListOptions,
): Promise<PageResult> {
  return fetchPages(client, `/2.1/projects/${encodeURIComponent(input.projectId)}/forms/attachments`, input);
}

export type PlanKind = 'inspection' | 'test';
export type PlanPart = 'plans' | 'items' | 'itemZones' | 'registrations';

const PLAN_PATHS: Record<PlanKind, Record<PlanPart, string>> = {
  inspection: {
    plans: '/1.2/projects/{projectId}/inspectionPlans',
    items: '/1.1/projects/{projectId}/inspectionPlanItems',
    itemZones: '/1.1/projects/{projectId}/inspectionPlanItemZones',
    registrations: '/2.1/projects/{projectId}/inspectionPlanRegistrations',
  },
  test: {
    plans: '/1.2/projects/{projectId}/testPlans',
    items: '/1.1/projects/{projectId}/testPlanItems',
    itemZones: '/1.1/projects/{projectId}/testPlanItemZones',
    registrations: '/1.2/projects/{projectId}/testPlanRegistrations',
  },
};

export async function listQualityPlans(
  client: DaluxClient,
  input: { projectId: string; kind: PlanKind; part: PlanPart } & ListOptions,
): Promise<PageResult> {
  const template = PLAN_PATHS[input.kind]?.[input.part];
  if (!template) {
    throw new Error(`Unknown quality plan selection: kind=${input.kind} part=${input.part}`);
  }
  const path = template.replace('{projectId}', encodeURIComponent(input.projectId));
  return fetchPages(client, path, input);
}
