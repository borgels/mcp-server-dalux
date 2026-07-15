import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkToolPolicy } from '../src/dalux/policy.js';
import { DaluxClient } from '../src/dalux/client.js';
import { uploadFile } from '../src/dalux/box.js';
import { changeCompany } from '../src/dalux/companies.js';
import { createProject } from '../src/dalux/projects.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function stubClient(): DaluxClient {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ data: { uploadGuid: 'g' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
  return new DaluxClient({ apiKey: 'k', fetchImpl });
}

describe('tool policy', () => {
  it('always allows read tools and never unknown tools', () => {
    expect(checkToolPolicy('dalux_list_tasks').allowed).toBe(true);
    expect(checkToolPolicy('dalux_download_file').allowed).toBe(true);
    expect(checkToolPolicy('dalux_delete_everything').allowed).toBe(false);
  });

  it('gates write tools on DALUX_ENABLE_WRITES', () => {
    delete process.env.DALUX_ENABLE_WRITES;
    expect(checkToolPolicy('dalux_upload_file')).toMatchObject({ allowed: false });
    expect(checkToolPolicy('dalux_change_company')).toMatchObject({ allowed: false });
    expect(checkToolPolicy('dalux_change_project')).toMatchObject({ allowed: false });

    process.env.DALUX_ENABLE_WRITES = 'true';
    expect(checkToolPolicy('dalux_upload_file')).toMatchObject({ allowed: true });
  });

  it('write modules refuse to call the API when writes are disabled', async () => {
    delete process.env.DALUX_ENABLE_WRITES;
    const client = stubClient();

    await expect(
      uploadFile(client, {
        projectId: '1',
        fileAreaId: '2',
        fileName: 'x.pdf',
        fileType: 'document',
        contentBase64: Buffer.from('x').toString('base64'),
        folderId: '3',
      }),
    ).rejects.toThrow('disabled');

    await expect(
      changeCompany(client, { scope: 'catalog', action: 'create', body: { name: 'X' } }),
    ).rejects.toThrow('disabled');

    await expect(client.get('/probe')).resolves.toBeTruthy();

    await expect(
      createProject(client, { adminEmail: 'a@b.dk', body: {} }),
    ).rejects.toThrow('disabled');
  });

  it('upload validates folderId/fileId exclusivity before touching the API', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const client = stubClient();
    const base = {
      projectId: '1',
      fileAreaId: '2',
      fileName: 'x.pdf',
      fileType: 'document' as const,
      contentBase64: Buffer.from('x').toString('base64'),
    };

    await expect(uploadFile(client, base)).rejects.toThrow('folderId');
    await expect(uploadFile(client, { ...base, folderId: 'a', fileId: 'b' })).rejects.toThrow('not both');
  });
});
