import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaluxClient, DownloadLinkError } from '../src/dalux/client.js';
import { getExportConfig } from '../src/export/config.js';
import { DownloadStore, EXPORT_UNAVAILABLE_MESSAGE, fileTarget, redactDownloadPath } from '../src/export/delivery.js';
import { ExportWorkspace, exportWorkspace, STALE_SUBDIR_MS } from '../src/export/workspace.js';
import { compareNumbering, extensionFor, toCsv } from '../src/export/quality-plans.js';
import { crc32, tableCrc32, ZipWriter } from '../src/export/zip.js';
import { createDaluxGateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { startHttpServer, type RunningHttpServer } from '../src/transports/http-server.js';
import { auditLines, BASE } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dalux-export-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('DALUX_')) {
      delete process.env[name];
    }
  }
  process.env.DALUX_EXPORT_DIR = join(dir, 'exports');
  // Gateways in these tests keep archives on disk unless a test says otherwise.
  process.env.DALUX_EXPORT_DELIVERY = 'file';
  // Keep the free-space check independent of the test machine's disk.
  process.env.DALUX_EXPORT_MAX_TOTAL_BYTES = String(16 * 1024 * 1024);
});

/** All .zip files below a directory. */
function zipsBelow(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return readdirSync(path, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.zip'));
}

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials and link tokens, built at runtime. */
const API_KEY = `key-${'k'.repeat(16)}`;
const linkToken = (n: number) => `tok${String(n).padStart(3, '0')}${'z'.repeat(12)}`;
const ORIGIN = new URL(BASE).origin;
const PROJECT = '900000000000000001';
const BOM = String.fromCharCode(0xfeff);
const P = `${BASE}`;

// ---------------------------------------------------------------------------
// ZIP reader (central directory), independent of the writer.

interface ZipEntry {
  name: string;
  data: Buffer;
  method: number;
}

function readZip(path: string): ZipEntry[] {
  const buf = readFileSync(path);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(-1);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(offset)).toBe(0x02014b50);
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localName = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buf.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length, name).toBe(size);
    expect(tableCrc32(data), name).toBe(crc);
    entries.push({ name, data, method });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipJson(entries: ZipEntry[], name: string): Record<string, any> {
  return JSON.parse(entries.find(entry => entry.name === name)!.data.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Synthetic Dalux project.

type Route = { status?: number; json?: unknown; bytes?: Buffer; contentType?: string };

function list(items: unknown[]) {
  return { items, metadata: { totalItems: items.length, totalRemainingItems: 0 }, links: [{ rel: 'self', href: 'x', method: 'GET' }] };
}

function link(n: number, name: string): string {
  return `${ORIGIN}/service/FieldBinaryStore/Project/${PROJECT}/ChecklistAttachment/a${n}/Token/${linkToken(n)}/${name}`;
}

const photo = (n: number, size = 64) => Buffer.alloc(size, n);

function fixture() {
  const forms = [
    form('f-late', '2026-03-02T10:00:00Z', { location: true }),
    form('f-early', '2026-03-01T09:00:00Z'),
    form('f-b', '2026-02-01T08:00:00Z'),
    form('f-gone', '2026-02-01T08:00:00Z', { deleted: true }),
  ];
  const routes: Record<string, Route> = {
    [`${P}/1.2/projects/${PROJECT}/inspectionPlans`]: { json: list([]) },
    [`${P}/1.1/projects/${PROJECT}/inspectionPlanItems`]: { json: list([]) },
    [`${P}/1.1/projects/${PROJECT}/inspectionPlanItemZones`]: { json: list([]) },
    [`${P}/2.1/projects/${PROJECT}/inspectionPlanRegistrations`]: { json: list([]) },
    [`${P}/1.2/projects/${PROJECT}/testPlans`]: {
      json: list([
        { testPlanId: 'tp-z', name: 'Zeta facade', workpackageId: 'wp1' },
        { testPlanId: 'tp-a', name: 'Åbent fundament', workpackageId: 'wp1' },
      ]),
    },
    [`${P}/1.1/projects/${PROJECT}/testPlanItems`]: {
      json: list([
        item('i10', 'tp-a', '10', 'Tenth'),
        item('i2', 'tp-a', '2', 'Second'),
        item('i1-2', 'tp-a', '1.2', 'One two'),
        item('i-empty', 'tp-a', '3', 'Never registered'),
        item('iz1', 'tp-z', '1', 'Facade'),
      ]),
    },
    [`${P}/1.1/projects/${PROJECT}/testPlanItemZones`]: {
      json: list([{ testPlanItemZoneId: 'z1', testPlanItemId: 'i2', name: 'North', planned: 1, ongoing: 0, completed: 1 }]),
    },
    [`${P}/1.2/projects/${PROJECT}/testPlanRegistrations`]: {
      json: list([
        { status: 'planned', formId: 'f-late', testPlanItemId: 'i2', testPlanItemZoneId: 'z1' },
        { status: 'not_planned', formId: 'f-early', testPlanItemId: 'i2' },
        { status: 'not_planned', formId: 'f-b', testPlanItemId: 'iz1' },
        { status: 'not_planned', formId: 'f-gone', testPlanItemId: 'i10' },
        { status: 'not_planned', formId: 'f-missing', testPlanItemId: 'i1-2' },
      ]),
    },
    [`${P}/2.2/projects/${PROJECT}/forms`]: { json: list(forms.map(data => ({ data, links: [] }))) },
    [`${P}/2.1/projects/${PROJECT}/forms/attachments`]: {
      json: list([
        attachment(2, 'f-late', 'photo-b.jpg', '2026-03-02T10:05:00Z', 'fk-photo'),
        attachment(1, 'f-late', 'photo-a.JPEG', '2026-03-02T10:01:00Z', 'fk-photo'),
        attachment(3, 'f-early', 'signature.png', undefined, 'fk-sign'),
        attachment(4, 'f-b', 'noext', '2026-02-01T08:01:00Z', 'fk-photo'),
      ]),
    },
    [`${P}/1.2/projects/${PROJECT}/users`]: {
      json: list([{ data: { userId: 'u1', firstName: 'Test', lastName: 'Person', email: 'person@example.test' } }]),
    },
    [`${P}/1.0/projects/${PROJECT}/workpackages`]: { json: list([{ data: { workpackageId: 'wp1', name: 'Concrete' } }]) },
    [`${P}/5.0/projects/${PROJECT}`]: { json: { data: { projectId: PROJECT, projectName: 'Example build', number: 'EX-1' } } },
    [link(1, 'photo-a.JPEG')]: { bytes: photo(1), contentType: 'image/jpeg' },
    [link(2, 'photo-b.jpg')]: { bytes: photo(2), contentType: 'image/jpeg' },
    [link(3, 'signature.png')]: { bytes: photo(3), contentType: 'image/png' },
    [link(4, 'noext')]: { bytes: photo(4), contentType: 'image/webp' },
    [link(90, 'snap-1.png')]: { bytes: photo(90), contentType: 'image/png' },
    [link(91, 'snap-2.png')]: { bytes: photo(91), contentType: 'image/png' },
  };
  return routes;
}

function item(id: string, planId: string, number: string, subject: string) {
  return {
    testPlanItemId: id,
    testPlanId: planId,
    number,
    subject,
    heading: 'H',
    subHeading: 'S',
    extentType: 'no_extent',
    planned: 1,
    ongoing: 0,
    completed: 1,
    nonPlannedOngoing: 0,
    nonPlannedCompleted: 0,
  };
}

function form(id: string, created: string, options: { location?: boolean; deleted?: boolean } = {}) {
  return {
    formId: id,
    type: 'regular',
    number: `KS-${id}`,
    template: { name: 'Checklist' },
    status: 'closed',
    workpackageId: 'wp1',
    created,
    createdBy: { userId: 'u1' },
    modified: created,
    modifiedBy: { userId: 'u-unknown' },
    deleted: options.deleted ?? false,
    ...(options.location
      ? {
          location: {
            coordinate: { xyz: { x: 1.5, y: -2, z: 0 } },
            building: { name: 'B1' },
            level: { name: 'L2' },
            drawing: { name: 'Plan 2' },
            locationImages: [
              { name: 'snap-1.png', fileDownload: link(90, 'snap-1.png') },
              { name: 'snap-2.png', fileDownload: link(91, 'snap-2.png') },
            ],
          },
        }
      : {}),
    userDefinedFields: {
      items: [
        { key: 'fk-text', name: 'Comment', values: [{ text: '=SUM(A1)' }] },
        { key: 'fk-ref', name: 'Result', values: [{ reference: { key: 'r1', value: 'Approved' } }] },
        { key: 'fk-who', name: 'Checked by', values: [{ relation: { userId: 'u1' } }] },
        { key: 'fk-photo', name: 'Photos', values: [] },
        { key: 'fk-sign', name: 'Signature', values: [] },
      ],
    },
    testPlanItems: [],
  };
}

function attachment(n: number, formId: string, name: string, created: string | undefined, fieldKey: string) {
  return {
    attachmentId: `att-${n}`,
    formId,
    created,
    modified: created,
    deleted: false,
    userDefinedField: { key: fieldKey },
    attachmentData: { mediaFile: { name, fileDownload: link(n, name) } },
  };
}

function fakeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input).split('?')[0]!;
    const route = routes[url];
    if (!route) {
      return Response.json({ message: 'not found' }, { status: 404 });
    }
    if (route.bytes) {
      return new Response(route.bytes, {
        status: route.status ?? 200,
        headers: { 'content-type': route.contentType ?? 'application/octet-stream', 'content-length': String(route.bytes.length) },
      });
    }
    return Response.json(route.json ?? { message: 'error' }, { status: route.status ?? 200 });
  });
}

function gatewayFor(routes: Record<string, Route>, extra: Record<string, unknown> = {}) {
  const fetchImpl = fakeFetch(routes);
  const gw = createDaluxGateway({
    apiKey: API_KEY,
    baseUrl: BASE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retryBaseDelayMs: 0,
    ...extra,
  });
  return { gw, fetchImpl };
}

async function runExport(routes = fixture(), input: Record<string, unknown> = {}) {
  const { gw, fetchImpl } = gatewayFor(routes);
  const result = await gw.callTool('export_quality_plans', { projectId: PROJECT, ...input } as never);
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const data = result.structuredContent as Record<string, any>;
  return { data, entries: readZip(data.path), fetchImpl, result };
}

// ---------------------------------------------------------------------------

describe('dalux_export_quality_plans', () => {
  it('writes index.json, CSVs and photos in a deterministic order', async () => {
    const { data, entries } = await runExport();
    expect(data.delivery).toBe('file');
    expect(data.path.startsWith(join(dir, 'exports'))).toBe(true);
    expect(data.fileName).toMatch(/^dalux-quality-plans-900000000000000001-\d{8}-\d{6}Z\.zip$/);
    expect(data.sizeBytes).toBe(readFileSync(data.path).length);

    const names = entries.map(entry => entry.name);
    // Plans in code point order of their names (stable across platforms).
    expect(names).toEqual([
      'photos/test-tp-z/f-b-1.webp',
      'photos/test-tp-a/f-early-1.png',
      'photos/test-tp-a/f-late-1.jpg',
      'photos/test-tp-a/f-late-2.jpg',
      'photos/test-tp-a/f-late-location-1.png',
      'photos/test-tp-a/f-late-location-2.png',
      'index.json',
      'index.csv',
      'registrations.csv',
    ]);
    expect(entries.find(e => e.name === 'photos/test-tp-a/f-late-1.jpg')!.data.equals(photo(1))).toBe(true);
    expect(entries.find(e => e.name === 'photos/test-tp-a/f-late-1.jpg')!.method).toBe(0);
    expect(entries.find(e => e.name === 'index.json')!.method).toBe(8);

    const index = zipJson(entries, 'index.json');
    expect(index.schemaVersion).toBe(1);
    expect(index.project).toEqual({ projectId: PROJECT, number: 'EX-1', name: 'Example build' });
    expect(index.plans.map((plan: any) => plan.name)).toEqual(['Zeta facade', 'Åbent fundament']);
    const [planZ, planA] = index.plans;
    expect(planZ.planCode).toBe('test-tp-z');
    expect(planA.planCode).toBe('test-tp-a');
    expect(planA.workpackage).toEqual({ workpackageId: 'wp1', name: 'Concrete' });
    expect(planA.controlPoints.map((point: any) => point.number)).toEqual(['1.2', '2', '3', '10']);
    expect(planA.coverage).toEqual({ controlPoints: 4, withRegistrations: 2, withoutRegistrations: 2 });

    const second = planA.controlPoints[1];
    expect(second.zones).toEqual([{ zoneId: 'z1', name: 'North', planned: 1, ongoing: 0, completed: 1 }]);
    // Registrations by creation time; a deleted form is left out.
    expect(second.registrations.map((r: any) => r.registrationId)).toEqual(['f-early', 'f-late']);
    const late = second.registrations[1];
    expect(late).toMatchObject({
      formId: 'f-late',
      zoneId: 'z1',
      registrationStatus: 'planned',
      formNumber: 'KS-f-late',
      template: 'Checklist',
      status: 'closed',
      createdBy: { userId: 'u1', name: 'Test Person', email: 'person@example.test' },
      modifiedBy: { userId: 'u-unknown' },
      location: { building: 'B1', level: 'L2', drawing: 'Plan 2', xyz: { x: 1.5, y: -2, z: 0 }, gps: null },
    });
    expect(late.fields.map((f: any) => [f.name, f.text])).toEqual([
      ['Comment', '=SUM(A1)'],
      ['Result', 'Approved'],
      ['Checked by', 'Test Person'],
      ['Photos', ''],
      ['Signature', ''],
    ]);
    expect(late.photos.map((p: any) => [p.path, p.kind, p.fieldName, p.sizeBytes])).toEqual([
      ['photos/test-tp-a/f-late-1.jpg', 'attachment', 'Photos', 64],
      ['photos/test-tp-a/f-late-2.jpg', 'attachment', 'Photos', 64],
      ['photos/test-tp-a/f-late-location-1.png', 'location', null, 64],
      ['photos/test-tp-a/f-late-location-2.png', 'location', null, 64],
    ]);
    // Every photo path in index.json exists in the archive.
    const paths = index.plans.flatMap((plan: any) =>
      plan.controlPoints.flatMap((point: any) => point.registrations.flatMap((r: any) => r.photos.map((p: any) => p.path))),
    );
    expect(paths.every((path: string) => names.includes(path))).toBe(true);

    // A registration whose form is not in the form list is kept and reported.
    expect(planA.controlPoints[0].registrations[0]).toMatchObject({ registrationId: 'f-missing', status: null, photos: [] });
    expect(index.failures).toEqual([{ scope: 'registration', target: 'f-missing', message: 'Form not found in the form list.' }]);
    expect(index.summary).toEqual({
      plans: 2,
      controlPoints: 5,
      controlPointsWithRegistrations: 3,
      controlPointsWithoutRegistrations: 2,
      registrations: 4,
      photos: 6,
      photosFailed: 0,
      photoBytes: 6 * 64,
      failures: 1,
    });
    expect(data.summary).toEqual(index.summary);
    expect(data.truncated).toBe(false);

    const csv = entries.find(e => e.name === 'registrations.csv')!.data.toString('utf8');
    expect(csv.startsWith(`${BOM}kind,planCode,plan,`)).toBe(true);
    expect(csv).toContain('Comment: =SUM(A1) | Result: Approved | Checked by: Test Person');
    expect(csv).toContain('photos/test-tp-a/f-late-1.jpg;photos/test-tp-a/f-late-2.jpg');
    const points = entries.find(e => e.name === 'index.csv')!.data.toString('utf8').trim().split('\r\n');
    expect(points).toHaveLength(6);
    expect(points[4]).toContain(',3,Never registered,');
    expect(points[4]).toContain(',0,no,');
  });

  it('produces the same archive layout and index for the same data', async () => {
    const first = await runExport();
    const second = await runExport();
    expect(second.entries.map(e => e.name)).toEqual(first.entries.map(e => e.name));
    const strip = (entries: ZipEntry[]) => ({ ...zipJson(entries, 'index.json'), generatedAt: null });
    expect(strip(second.entries)).toEqual(strip(first.entries));
  });

  it('filters by plan, kind and since, and can leave photos out', async () => {
    const { data, entries, fetchImpl } = await runExport(fixture(), {
      plans: ['zeta FACADE', 'no-such-plan'],
      since: '2026-01-15',
      includePhotos: false,
    });
    expect(entries.map(e => e.name)).toEqual(['index.json', 'index.csv', 'registrations.csv']);
    const index = zipJson(entries, 'index.json');
    expect(index.plans.map((plan: any) => plan.planId)).toEqual(['tp-z']);
    expect(index.failures).toEqual([{ scope: 'filter', target: 'no-such-plan', message: 'No plan with this id or name.' }]);
    expect(data.summary.registrations).toBe(1);
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.some(url => url.includes('/forms/attachments'))).toBe(false);
    expect(urls.some(url => url.includes('FieldBinaryStore'))).toBe(false);

    const later = await runExport(fixture(), { since: '2026-03-02T00:00:00Z' });
    const ids = zipJson(later.entries, 'index.json').plans.flatMap((plan: any) =>
      plan.controlPoints.flatMap((point: any) => point.registrations.map((r: any) => r.registrationId)),
    );
    expect(ids).toEqual(['f-late']);

    const inspectionOnly = await runExport(fixture(), { kind: 'inspection' });
    expect(zipJson(inspectionOnly.entries, 'index.json').plans).toEqual([]);
    expect(inspectionOnly.fetchImpl.mock.calls.some(([url]) => String(url).includes('testPlan'))).toBe(false);
  });

  it('lists failed downloads and lists instead of failing the export', async () => {
    const routes = fixture();
    routes[link(2, 'photo-b.jpg')] = { status: 500, json: { message: 'boom' } };
    routes[`${P}/1.2/projects/${PROJECT}/users`] = { status: 403, json: { errorCode: 'E40301', message: 'forbidden' } };
    const { data, entries } = await runExport(routes);
    const index = zipJson(entries, 'index.json');
    expect(entries.map(e => e.name)).not.toContain('photos/test-tp-a/f-late-2.jpg');
    expect(index.failures).toContainEqual({ scope: 'photo', target: 'photos/test-tp-a/f-late-2.*', message: 'Download failed with HTTP 500.' });
    expect(index.failures.some((f: any) => f.scope === 'list' && f.target === 'projectUsers')).toBe(true);
    expect(data.summary.photos).toBe(5);
    expect(data.summary.photosFailed).toBe(1);
    const late = index.plans[1].controlPoints[1].registrations[1];
    expect(late.photos[1]).toMatchObject({ path: null, error: 'Download failed with HTTP 500.' });
    expect(late.createdBy).toEqual({ userId: 'u1' });
    // Link tokens never reach the index or the result.
    const text = entries.find(e => e.name === 'index.json')!.data.toString('utf8') + JSON.stringify(data);
    expect(text).not.toContain('tok00');
    expect(text).not.toContain('FieldBinaryStore');
  });

  it('fails when no plan list can be read', async () => {
    const routes = fixture();
    for (const key of Object.keys(routes)) {
      if (key.endsWith('Plans')) {
        routes[key] = { status: 404, json: { errorCode: 'E40401' } };
      }
    }
    const { gw } = gatewayFor(routes);
    const result = await gw.callTool('export_quality_plans', { projectId: PROJECT });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Could not read the quality plans');
    expect(zipsBelow(join(dir, 'exports'))).toEqual([]);
  });

  it('times out slow lists and records them as failures', async () => {
    process.env.DALUX_EXPORT_TIMEOUT_MS = '1000';
    const routes = fixture();
    const base = fakeFetch(routes);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/projects/' + PROJECT + '/users')) {
        await new Promise(resolve => setTimeout(resolve, 1300));
      }
      return base(input, init);
    });
    const gw = createDaluxGateway({ apiKey: API_KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const started = Date.now();
    const result = await gw.callTool('export_quality_plans', { projectId: PROJECT, includePhotos: false });
    expect(Date.now() - started).toBeLessThan(1250);
    const index = zipJson(readZip((result.structuredContent as any).path), 'index.json');
    expect(index.failures).toContainEqual({
      scope: 'list',
      target: 'projectUsers',
      message: 'The export time limit was reached while reading the lists.',
    });
  });

  it('enforces the per-file, file count and total size caps', async () => {
    process.env.DALUX_EXPORT_MAX_FILE_BYTES = '1024';
    const routes = fixture();
    routes[link(1, 'photo-a.JPEG')] = { bytes: photo(1, 4096), contentType: 'image/jpeg' };
    const capped = await runExport(routes);
    const failure = zipJson(capped.entries, 'index.json').failures.find((f: any) => f.scope === 'photo');
    expect(failure.target).toBe('photos/test-tp-a/f-late-1.*');
    expect(failure.message).toContain('exceeds the 1024 byte limit');
    expect(capped.data.truncated).toBe(false);

    delete process.env.DALUX_EXPORT_MAX_FILE_BYTES;
    process.env.DALUX_EXPORT_MAX_FILES = '2';
    process.env.DALUX_EXPORT_MAX_TOTAL_BYTES = String(16 * 1024 * 1024);
    const counted = await runExport();
    expect(counted.entries.filter(e => e.name.startsWith('photos/')).map(e => e.name)).toEqual([
      'photos/test-tp-z/f-b-1.webp',
      'photos/test-tp-a/f-early-1.png',
    ]);
    expect(counted.data.truncated).toBe(true);
    expect(zipJson(counted.entries, 'index.json').truncated).toBe(true);
    expect(counted.data.summary.photosFailed).toBe(4);

    delete process.env.DALUX_EXPORT_MAX_FILES;
    process.env.DALUX_EXPORT_MAX_TOTAL_BYTES = String(1024 * 1024);
    const big = fixture();
    for (const n of [1, 2]) {
      big[link(n, n === 1 ? 'photo-a.JPEG' : 'photo-b.jpg')] = { bytes: photo(n, 600 * 1024), contentType: 'image/jpeg' };
    }
    const sized = await runExport(big);
    expect(sized.data.truncated).toBe(true);
    // The cap covers the whole archive, index files included.
    expect(sized.data.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(zipJson(sized.entries, 'index.json').limits.maxTotalBytes).toBe(1024 * 1024);
    expect(sized.entries.map(e => e.name)).toContain('photos/test-tp-a/f-early-1.png');
    expect(sized.entries.map(e => e.name)).toContain('photos/test-tp-a/f-late-1.jpg');
    expect(sized.entries.map(e => e.name)).not.toContain('photos/test-tp-a/f-late-2.jpg');
    // Once the cap is hit, the remaining files are skipped too.
    expect(sized.entries.map(e => e.name)).not.toContain('photos/test-tp-a/f-late-location-1.png');
  });

  it('stops downloading when the time budget is used up', async () => {
    process.env.DALUX_EXPORT_TIMEOUT_MS = '1000';
    const routes = fixture();
    const slow = fakeFetch(routes);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('FieldBinaryStore')) {
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
      return slow(input, init);
    });
    const gw = createDaluxGateway({ apiKey: API_KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await gw.callTool('export_quality_plans', { projectId: PROJECT });
    const data = result.structuredContent as Record<string, any>;
    expect(data.truncated).toBe(true);
    const index = zipJson(readZip(data.path), 'index.json');
    expect(index.failures.some((f: any) => f.message === 'Skipped: the export time limit was reached.')).toBe(true);
  });

  it('bounds the bytes of downloads in flight', async () => {
    process.env.DALUX_EXPORT_MAX_FILE_BYTES = String(600 * 1024);
    process.env.DALUX_EXPORT_MAX_INFLIGHT_BYTES = String(1024 * 1024);
    const base = fakeFetch(fixture());
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const download = String(input).includes('FieldBinaryStore');
      if (download) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
      }
      return base(input, init);
    });
    const gw = createDaluxGateway({ apiKey: API_KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await gw.callTool('export_quality_plans', { projectId: PROJECT });
    expect((result.structuredContent as any).summary.photos).toBe(6);
    expect(peak).toBe(1);

    process.env.DALUX_EXPORT_MAX_INFLIGHT_BYTES = String(2 * 1024 * 1024);
    peak = 0;
    await gw.callTool('export_quality_plans', { projectId: PROJECT });
    expect(peak).toBe(3);
  });

  it('refuses more concurrent exports than configured', async () => {
    process.env.DALUX_EXPORT_MAX_CONCURRENT = '1';
    const routes = fixture();
    const { gw } = gatewayFor(routes);
    const [a, b] = await Promise.all([
      gw.callTool('export_quality_plans', { projectId: PROJECT }),
      gw.callTool('export_quality_plans', { projectId: PROJECT }),
    ]);
    expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1);
    expect(texts(a.isError ? a : b)).toContain('already running');
  });

  it('rejects invalid since values before calling Dalux', async () => {
    const { gw, fetchImpl } = gatewayFor(fixture());
    const result = await gw.callTool('export_quality_plans', { projectId: PROJECT, since: 'last week' });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is refused without a delivery: gateway without hook, HTTP without public URL', async () => {
    delete process.env.DALUX_EXPORT_DELIVERY;
    const { gw, fetchImpl } = gatewayFor(fixture());
    const result = await gw.callTool('export_quality_plans', { projectId: PROJECT });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain(EXPORT_UNAVAILABLE_MESSAGE);
    expect(fetchImpl).not.toHaveBeenCalled();

    const fetchHttp = fakeFetch(fixture());
    const running = await startHttpServer(
      { host: '127.0.0.1', port: 0, maxBodyBytes: 1_000_000, httpToken: HTTP_TOKEN },
      {
        log: () => undefined,
        createMcpServer: (context, exportTarget) =>
          createServer({
            client: new DaluxClient({ apiKey: API_KEY, baseUrl: BASE, fetchImpl: fetchHttp as unknown as typeof fetch }),
            callContext: context,
            exportTarget,
          }),
      },
    );
    try {
      const reply = await callExport(running.port);
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain('DALUX_PUBLIC_BASE_URL');
      expect((await send(running.port, '/downloads/x/y.zip')).status).toBe(404);
    } finally {
      await running.close();
    }
  });

  it('deletes the archive when the delivery hook fails', async () => {
    const hook = vi.fn(async () => {
      throw new Error('upload failed');
    });
    const { gw } = gatewayFor(fixture(), { exportDelivery: hook });
    const result = await gw.callTool('export_quality_plans', { projectId: PROJECT });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain('upload failed');
    expect(zipsBelow(join(dir, 'exports'))).toEqual([]);
    expect((await exportWorkspace(join(dir, 'exports'))).storedCount).toBe(0);
  });

  it('hands the archive to a gateway delivery hook', async () => {
    const hook = vi.fn(async (file: { path: string; fileName: string; sizeBytes: number }) => {
      rmSync(file.path);
      return { delivery: 'host' as const, url: 'https://files.example.test/x' };
    });
    delete process.env.DALUX_EXPORT_DELIVERY;
    const { gw } = gatewayFor(fixture(), { exportDelivery: hook });
    const result = await gw.callTool('export_quality_plans', { projectId: PROJECT });
    expect(result.isError).toBeFalsy();
    expect(hook).toHaveBeenCalledTimes(1);
    // The host owns the file now: it no longer counts as stored here.
    expect((await exportWorkspace(join(dir, 'exports'))).storedCount).toBe(0);
    expect(hook.mock.calls[0]![0]).toMatchObject({ contentType: 'application/zip' });
    expect(result.structuredContent).toMatchObject({ delivery: 'host', url: 'https://files.example.test/x' });
  });

  it('audits counts and size without links, tokens or plan names', async () => {
    const auditPath = join(dir, 'audit.jsonl');
    process.env.DALUX_AUDIT_LOG = auditPath;
    await runExport(fixture(), { plans: ['Zeta facade'] });
    const lines = auditLines(auditPath);
    const finish = lines.find(line => line.action === 'finish')!;
    expect(finish.target).toMatchObject({ projectId: PROJECT, planFilters: 1 });
    expect(finish.details).toMatchObject({ plans: 1, registrations: 1, photos: 1, delivery: 'file', truncated: false });
    expect(typeof (finish.details as any).sizeBytes).toBe('number');
    const text = readFileSync(auditPath, 'utf8');
    expect(text).not.toContain('Zeta');
    expect(text).not.toContain('tok00');
    expect(text).not.toContain(API_KEY);
  });
});

function texts(result: { content: Array<{ text: string }> }): string {
  return result.content.map(c => c.text).join(' ');
}

// ---------------------------------------------------------------------------

describe('download links of the Dalux client', () => {
  const client = (fetchImpl: unknown) =>
    new DaluxClient({ apiKey: API_KEY, baseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, retryBaseDelayMs: 0 });

  it('only follows links on the API origin without dot segments', async () => {
    const fetchImpl = vi.fn();
    const c = client(fetchImpl);
    for (const href of [
      'https://elsewhere.example.test/service/FieldBinaryStore/x.jpg',
      `${ORIGIN}/service/FieldBinaryStore/../api/x`,
      `${ORIGIN}/service/FieldBinaryStore/%2e%2e/x`,
      'not a url',
      `https://user:pw@${new URL(BASE).host}/service/x`,
    ]) {
      await expect(c.getBinaryLink(href, 1000)).rejects.toBeInstanceOf(DownloadLinkError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never repeats the link in errors', async () => {
    const href = link(7, 'x.jpg');
    const failing = client(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    });
    const error = (await failing.getBinaryLink(href, 1000).catch((e: Error) => e)) as Error;
    expect(error).toBeInstanceOf(DownloadLinkError);
    expect(error.message).not.toContain(linkToken(7));
    const notFound = client(async () => Response.json({ message: `missing ${href}` }, { status: 404 }));
    const error404 = (await notFound.getBinaryLink(href, 1000).catch((e: Error) => e)) as DownloadLinkError;
    expect(error404.message).toBe('Download failed with HTTP 404.');
    expect(error404.status).toBe(404);
  });

  it('sends the API key to the API origin', async () => {
    const fetchImpl = vi.fn(async () => new Response(photo(1), { headers: { 'content-type': 'image/jpeg' } }));
    const result = await client(fetchImpl).getBinaryLink(link(1, 'a.jpg'), 1000);
    expect(result.bytes.length).toBe(64);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe(API_KEY);
  });
});

// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function send(port: number, path: string, method = 'GET', body?: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const HTTP_TOKEN = `http-${'t'.repeat(40)}`;

async function callExport(port: number): Promise<{ isError: boolean; text: string }> {
  const reply = await send(
    port,
    '/mcp',
    'POST',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dalux_export_quality_plans', arguments: { projectId: PROJECT } } }),
    { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${HTTP_TOKEN}` },
  );
  const body = reply.body.toString('utf8');
  const line = body.split('\n').find(l => l.startsWith('data:')) ?? body;
  const message = JSON.parse(line.replace(/^data: ?/, ''));
  return { isError: message.result.isError === true, text: message.result.content[0].text };
}
const PUBLIC = 'https://mcp.example.test';

describe('download store over HTTP', () => {
  let running: RunningHttpServer | undefined;
  const logs: string[] = [];
  let clock = Date.now();

  afterEach(async () => {
    await running?.close();
    running = undefined;
    logs.length = 0;
  });

  async function start(overrides: { oneTime?: boolean; ttlMs?: number } = {}) {
    const config = { ...getExportConfig(), publicBaseUrl: PUBLIC, ttlMs: overrides.ttlMs ?? 60_000, oneTime: overrides.oneTime ?? false };
    const workspace = await ExportWorkspace.create(join(dir, 'exports'));
    const downloads = new DownloadStore({ config, workspace, log: line => logs.push(line), now: () => clock });
    const fetchImpl = fakeFetch(fixture());
    running = await startHttpServer(
      { host: '127.0.0.1', port: 0, maxBodyBytes: 1_000_000, httpToken: HTTP_TOKEN },
      {
        downloads,
        log: line => logs.push(line),
        createMcpServer: (context, exportTarget) =>
          createServer({
            client: new DaluxClient({ apiKey: API_KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }),
            callContext: context,
            exportTarget,
          }),
      },
    );
    return { port: running.port, downloads, workspace };
  }

  async function exportLink(port: number): Promise<{ url: string; data: Record<string, any> }> {
    const reply = await send(
      port,
      '/mcp',
      'POST',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dalux_export_quality_plans', arguments: { projectId: PROJECT } } }),
      {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${HTTP_TOKEN}`,
      },
    );
    expect(reply.status).toBe(200);
    const text = reply.body.toString('utf8');
    const line = text.split('\n').find(l => l.startsWith('data:')) ?? text;
    const message = JSON.parse(line.replace(/^data: ?/, ''));
    const data = JSON.parse(message.result.content[0].text);
    return { url: data.url, data };
  }

  it('serves a capability URL without the MCP token and expires it', async () => {
    const { port, downloads } = await start();
    const { url, data } = await exportLink(port);
    expect(data.delivery).toBe('link');
    expect(data.path).toBeUndefined();
    expect(url).toMatch(/^https:\/\/mcp\.example\.test\/downloads\/[A-Za-z0-9_-]{43}\/dalux-quality-plans-EX-1-[0-9TZ-]+\.zip$/);
    expect(Date.parse(data.expiresAt) - clock).toBe(60_000);
    const path = new URL(url).pathname;

    const head = await send(port, path, 'HEAD');
    expect(head.status).toBe(200);
    const ok = await send(port, path);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/zip');
    expect(ok.headers['content-disposition']).toBe(`attachment; filename="${data.fileName}"`);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(Number(ok.headers['content-length'])).toBe(data.sizeBytes);
    expect(ok.body.length).toBe(data.sizeBytes);
    expect(ok.body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect((await send(port, path)).status).toBe(200); // not one-time

    clock += 60_001;
    expect((await send(port, path)).status).toBe(404);
    await downloads.sweep();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(zipsBelow(join(dir, 'exports'))).toEqual([]);

    // Neither the token nor the link reaches the logs.
    const token = path.split('/')[2]!;
    expect(logs.join('\n')).not.toContain(token);
    expect(logs.some(line => line.includes('served'))).toBe(true);
  });

  it('answers 404 for unknown tokens, wrong names and traversal attempts', async () => {
    const { port } = await start();
    const { url, data } = await exportLink(port);
    const token = new URL(url).pathname.split('/')[2]!;
    const other = 'A'.repeat(43);
    for (const path of [
      `/downloads/${other}/${data.fileName}`,
      `/downloads/${token}/other.zip`,
      `/downloads/${token}`,
      `/downloads/${token}/`,
      `/downloads/`,
      `/downloads/${token}/..%2F..%2Fetc%2Fpasswd`,
      `/downloads/${token}/../../package.json`,
      `/downloads/../package.json`,
      `/downloads/${token.slice(0, 42)}/${data.fileName}`,
      `/downloads/${token}x/${data.fileName}`,
    ]) {
      const reply = await send(port, path);
      expect(reply.status, path).toBe(404);
      expect(reply.body.toString('utf8')).toBe('{"error":"Not found"}');
    }
    expect((await send(port, new URL(url).pathname, 'POST')).status).toBe(405);
    // /mcp still needs the bearer token.
    expect((await send(port, '/mcp', 'POST', '{}', { 'Content-Type': 'application/json' })).status).toBe(401);
    const joined = logs.join('\n');
    expect(joined).not.toContain(token);
  });

  it('one-time links work once', async () => {
    const { port, downloads } = await start({ oneTime: true });
    const { url } = await exportLink(port);
    const path = new URL(url).pathname;
    expect((await send(port, path)).status).toBe(200);
    expect((await send(port, path)).status).toBe(404);
    expect(downloads.size).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 50));
    await downloads.sweep();
    expect(zipsBelow(join(dir, 'exports'))).toEqual([]);
  });

  it('refuses new exports while the stored-archive limits are reached, without evicting links', async () => {
    process.env.DALUX_EXPORT_MAX_STORED_ENTRIES = '1';
    const { port, downloads } = await start();
    const { url } = await exportLink(port);
    const second = await callExport(port);
    expect(second.isError).toBe(true);
    expect(second.text).toContain('DALUX_EXPORT_MAX_STORED_ENTRIES');
    // The first link still works.
    expect((await send(port, new URL(url).pathname)).status).toBe(200);
    // Once it has expired, there is room again.
    clock += 60_001;
    await downloads.sweep();
    expect((await callExport(port)).isError).toBe(false);
  });

});

describe('export workspace', () => {
  const caps = { maxTotalBytes: 16 * 1024 * 1024, maxStoredBytes: 40 * 1024 * 1024, maxStoredEntries: 3 };
  const plenty = async () => 100 * 1024 * 1024 * 1024;

  it('works in its own subdirectory and removes only stale subdirectories of earlier processes', async () => {
    const root = join(dir, 'ws');
    mkdirSync(root, { mode: 0o700 });
    const stale = join(root, 'dalux-export-AbC123');
    const fresh = join(root, 'dalux-export-XyZ789');
    const other = join(root, 'dalux-export-notours-really');
    for (const path of [stale, fresh, other]) {
      mkdirSync(path);
      writeFileSync(join(path, 'a.zip'), 'x');
    }
    const keep = join(root, 'my-report.zip');
    writeFileSync(keep, 'x');
    const old = (Date.now() - STALE_SUBDIR_MS - 60_000) / 1000;
    utimesSync(stale, old, old);

    const workspace = await ExportWorkspace.create(root, { freeBytes: plenty });
    expect(workspace.dir.startsWith(join(root, 'dalux-export-'))).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(keep)).toBe(true);
  });

  it('caps stored archives by count and bytes, and counts reservations', async () => {
    const workspace = await ExportWorkspace.create(join(dir, 'ws'), { freeBytes: plenty });
    const first = await workspace.reserve(caps);
    expect(first.maxBytes).toBe(16 * 1024 * 1024);
    first.commit(join(workspace.dir, 'a.zip'), 30 * 1024 * 1024);
    // 10 MB left of the 40 MB: the next archive is capped to that.
    const second = await workspace.reserve(caps);
    expect(second.maxBytes).toBe(10 * 1024 * 1024);
    await expect(workspace.reserve(caps)).rejects.toThrow(/DALUX_EXPORT_MAX_STORED_BYTES/);
    second.release();
    workspace.forget(join(workspace.dir, 'a.zip'));
    const a = await workspace.reserve(caps);
    const b = await workspace.reserve(caps);
    await workspace.reserve(caps);
    await expect(workspace.reserve(caps)).rejects.toThrow(/DALUX_EXPORT_MAX_STORED_ENTRIES/);
    a.release();
    b.release();
  });

  it('refuses an export when the disk has less free space than the cap plus margin', async () => {
    const workspace = await ExportWorkspace.create(join(dir, 'ws'), { freeBytes: async () => 50 * 1024 * 1024 });
    await expect(workspace.reserve(caps)).rejects.toThrow(/free disk space/);
  });

  it('retries deletions that fail, and keeps counting the file until then', async () => {
    const workspace = await ExportWorkspace.create(join(dir, 'ws'), { freeBytes: plenty });
    const busy = join(workspace.dir, 'busy.zip');
    // A non-empty directory cannot be removed without recursion: stands in for a busy file.
    mkdirSync(busy);
    writeFileSync(join(busy, 'x'), 'x');
    workspace.reserve(caps).then(r => r.commit(busy, 1024));
    await new Promise(resolve => setTimeout(resolve, 10));
    await workspace.remove(busy);
    expect(workspace.pendingDeleteCount).toBe(1);
    expect(workspace.storedCount).toBe(1);
    rmSync(busy, { recursive: true });
    writeFileSync(busy, 'x');
    await workspace.retryDeletes();
    expect(workspace.pendingDeleteCount).toBe(0);
    expect(workspace.storedCount).toBe(0);
    expect(existsSync(busy)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked or group-writable export directory', async () => {
    const real = join(dir, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(dir, 'link');
    symlinkSync(real, link);
    await expect(ExportWorkspace.create(link)).rejects.toThrow(/symbolic link/);
    const open = join(dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    await expect(ExportWorkspace.create(open)).rejects.toThrow(/group or others/);
  });

  it('keeps file deliveries outside the process subdirectory', async () => {
    const workspace = await ExportWorkspace.create(join(dir, 'ws'), { freeBytes: plenty });
    const reservation = await workspace.reserve(caps);
    const path = join(workspace.dir, 'x.zip');
    writeFileSync(path, 'zip');
    reservation.commit(path, 3);
    const result = await fileTarget().deliver({ path, fileName: 'report.zip', sizeBytes: 3, contentType: 'application/zip' }, workspace);
    expect(result).toEqual({ delivery: 'file', path: join(dir, 'ws', 'report.zip') });
    expect(workspace.storedCount).toBe(0);
  });
});

describe('export helpers', () => {
  it('redacts download paths for logs', () => {
    expect(redactDownloadPath('/downloads/abc/def.zip')).toBe('/downloads/[redacted]');
    expect(redactDownloadPath('/mcp')).toBe('/mcp');
  });

  it('computes CRC-32 like zlib', () => {
    const data = Buffer.from('123456789');
    expect(tableCrc32(data)).toBe(0xcbf43926);
    expect(crc32(data)).toBe(0xcbf43926);
  });

  it('orders control point numbers naturally', () => {
    expect(['10', '2', '1.10', '1.2', '1', 'A', '2a'].sort(compareNumbering)).toEqual(['1', '1.2', '1.10', '2', '2a', '10', 'A']);
  });

  it('derives extensions from names or content types', () => {
    expect(extensionFor('a.JPEG', 'image/png')).toBe('jpg');
    expect(extensionFor('noext', 'image/webp; q=1')).toBe('webp');
    expect(extensionFor(undefined, 'application/x-unknown')).toBe('bin');
    expect(extensionFor('plan.DWG', 'application/octet-stream')).toBe('dwg');
    expect(extensionFor('model.ifc', 'application/octet-stream')).toBe('ifc');
    expect(extensionFor('run.exe', 'application/octet-stream')).toBe('bin');
    expect(extensionFor('page.html', 'text/html')).toBe('bin');
    expect(extensionFor('evil.svg', 'image/png')).toBe('png');
  });

  it('writes CSV with quoting and a formula guard on text', () => {
    expect(toCsv([['a,b', '=1+1', -5, null, 'say "hi"']])).toBe(`${BOM}"a,b",'=1+1,-5,,"say ""hi"""\r\n`);
  });

  it('validates the export configuration', () => {
    expect(() => getExportConfig({ DALUX_PUBLIC_BASE_URL: 'http://mcp.example.test' })).toThrow(/https/);
    expect(() => getExportConfig({ DALUX_PUBLIC_BASE_URL: 'https://mcp.example.test/?a=1' })).toThrow(/query/);
    expect(() => getExportConfig({ DALUX_PUBLIC_BASE_URL: 'https://mcp.example.test/base/' })).toThrow(/without a path/);
    expect(getExportConfig({ DALUX_PUBLIC_BASE_URL: 'https://mcp.example.test/' }).publicBaseUrl).toBe('https://mcp.example.test');
    expect(() => getExportConfig({ DALUX_EXPORT_DELIVERY: 'link' })).toThrow(/DALUX_EXPORT_DELIVERY/);
    expect(() => getExportConfig({ DALUX_EXPORT_MAX_FILE_BYTES: String(512 * 1024 * 1024) })).toThrow(/DALUX_EXPORT_MAX_FILE_BYTES/);
    expect(getExportConfig({ DALUX_PUBLIC_BASE_URL: 'http://127.0.0.1:3000' }).publicBaseUrl).toBe('http://127.0.0.1:3000');
    expect(() => getExportConfig({ DALUX_EXPORT_MAX_TOTAL_BYTES: '9999999999' })).toThrow(/DALUX_EXPORT_MAX_TOTAL_BYTES/);
    expect(getExportConfig({}).ttlMs).toBe(30 * 60_000);
    expect(getExportConfig({})).toMatchObject({
      maxStoredBytes: 4096 * 1024 * 1024,
      maxStoredEntries: 20,
      maxFileBytes: 64 * 1024 * 1024,
      maxInflightBytes: 256 * 1024 * 1024,
    });
  });

  it('does not write the same ZIP entry twice', async () => {
    const zip = await ZipWriter.create(join(dir, 'd.zip'), new Date());
    await zip.add('a.txt', Buffer.from('a'));
    expect(zip.has('a.txt')).toBe(true);
    await expect(zip.add('a.txt', Buffer.from('b'))).rejects.toThrow(/Duplicate/);
    await zip.finish();
    expect(readZip(join(dir, 'd.zip')).map(e => e.name)).toEqual(['a.txt']);
  });
});

// ---------------------------------------------------------------------------
// The threat model for exports: nothing the host's hook receives holds the key.

describe('export and the API key', () => {
  const LEAKY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;

  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('redacts the archive and builds its names from ids before the hook sees it', async () => {
    const routes = fixture();
    // Dalux echoes the key in the project's name and number, a plan name, a field value and a photo's bytes.
    routes[`${P}/5.0/projects/${PROJECT}`] = { json: { data: { projectId: PROJECT, projectName: `Build ${LEAKY}`, number: LEAKY } } };
    const plans = routes[`${P}/1.2/projects/${PROJECT}/testPlans`]!.json as { items: Array<{ name: string }> };
    plans.items[0]!.name = `Zeta ${LEAKY}`;
    const forms = routes[`${P}/2.2/projects/${PROJECT}/forms`]!.json as { items: Array<{ data: any }> };
    forms.items[0]!.data.userDefinedFields.items[0].values = [{ text: `note ${LEAKY}` }];
    routes[link(1, 'photo-a.JPEG')] = { bytes: Buffer.concat([photo(1), Buffer.from(LEAKY.slice(2, 14), 'latin1')]), contentType: 'image/jpeg' };

    const seen: { fileName: string; entries: ZipEntry[] }[] = [];
    const hook = vi.fn(async (file: { path: string; fileName: string }) => {
      seen.push({ fileName: file.fileName, entries: readZip(file.path) });
      rmSync(file.path);
      return { delivery: 'host' as const, url: 'https://files.example.test/x' };
    });
    delete process.env.DALUX_EXPORT_DELIVERY;
    const { gw } = gatewayFor(routes, { apiKey: LEAKY, exportDelivery: hook });
    const result = await gw.callTool('export_quality_plans', { projectId: PROJECT });
    expect(result.isError, texts(result)).toBeFalsy();
    expect(seen).toHaveLength(1);

    const { fileName, entries } = seen[0]!;
    expect(fileName).toMatch(/^dalux-quality-plans-900000000000000001-\d{8}-\d{6}Z\.zip$/);
    // The photo with a piece of the key is left out and listed as a failure.
    expect(entries.map(entry => entry.name)).not.toContain('photos/test-tp-a/f-late-1.jpg');
    const index = zipJson(entries, 'index.json');
    expect(index.failures).toContainEqual(expect.objectContaining({ scope: 'photo', message: 'Left out: the file contains text that matches the API key.' }));
    expect(index.project).toMatchObject({ projectId: PROJECT });

    const everything = [
      fileName,
      JSON.stringify(result),
      ...entries.map(entry => entry.name),
      ...entries.map(entry => entry.data.toString('latin1')),
      ...entries.map(entry => entry.data.toString('utf8')),
    ].join('\n');
    for (const piece of pieces(LEAKY)) expect(everything).not.toContain(piece);
  });
});
