import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaluxClient } from '../src/dalux/client.js';
import { downloadFile, uploadContentDisposition, uploadFile } from '../src/dalux/box.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const BASE = 'https://field.dalux.com/service/api';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

describe('uploadFile', () => {
  it('sends Content-Range and Content-Disposition on every part, then finalizes', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body,
      });
      if (url.endsWith('/5.0/projects/p1')) {
        return new Response(JSON.stringify({ data: { modules: [{ type: 'box', tier: 'pro' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/upload')) {
        return new Response(JSON.stringify({ data: { uploadGuid: 'guid-1' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/finalize')) {
        return new Response(JSON.stringify({ data: { fileId: 'f1' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const client = new DaluxClient({ apiKey: 'k', fetchImpl });

    const content = Buffer.from('0123456789');
    const result = await uploadFile(
      client,
      {
        projectId: 'p1',
        fileAreaId: 'a1',
        folderId: 'folder-1',
        fileName: 'Tegning æø "A".pdf',
        fileType: 'document',
        contentBase64: content.toString('base64'),
      },
      { chunkBytes: 4 },
    );

    expect(result).toEqual({ data: { fileId: 'f1' } });
    expect(calls.map(call => `${call.method} ${call.url.replace(BASE, '')}`)).toEqual([
      'GET /5.0/projects/p1',
      'POST /1.0/projects/p1/file_areas/a1/upload',
      'POST /1.0/projects/p1/file_areas/a1/upload/guid-1',
      'POST /1.0/projects/p1/file_areas/a1/upload/guid-1',
      'POST /1.0/projects/p1/file_areas/a1/upload/guid-1',
      'POST /2.0/projects/p1/file_areas/a1/upload/guid-1/finalize',
    ]);

    const parts = calls.slice(2, 5);
    expect(parts.map(part => part.headers['Content-Range'])).toEqual([
      'bytes 0-3/10',
      'bytes 4-7/10',
      'bytes 8-9/10',
    ]);
    const disposition = `form-data; filename="Tegning __ _A_.pdf"; filename*=UTF-8''Tegning%20%C3%A6%C3%B8%20%22A%22.pdf`;
    for (const part of parts) {
      expect(part.headers['Content-Disposition']).toBe(disposition);
      expect(part.headers['Content-Type']).toBe('application/octet-stream');
      expect(part.headers['X-API-KEY']).toBe('k');
    }
    expect(parts.map(part => Buffer.from(part.body as Uint8Array).toString())).toEqual(['0123', '4567', '89']);

    const finalize = calls[5]!;
    expect(finalize.headers['Content-Range']).toBeUndefined();
    expect(finalize.headers['Content-Disposition']).toBeUndefined();
    expect(finalize.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(finalize.body))).toEqual({
      fileName: 'Tegning æø "A".pdf',
      fileType: 'document',
      folderId: 'folder-1',
    });
  });

  it('builds an ASCII-safe Content-Disposition', () => {
    expect(uploadContentDisposition('report.txt')).toBe(`form-data; filename="report.txt"; filename*=UTF-8''report.txt`);
    expect(uploadContentDisposition("it's (draft)*.txt")).toBe(
      `form-data; filename="it's (draft)*.txt"; filename*=UTF-8''it%27s%20%28draft%29%2A.txt`,
    );
    expect(uploadContentDisposition('a\\b\r\n.txt')).toBe(
      `form-data; filename="a_b__.txt"; filename*=UTF-8''a%5Cb%0D%0A.txt`,
    );
  });

  it('rejects a file name that cannot be encoded before reserving a slot', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
    const client = new DaluxClient({ apiKey: 'k', fetchImpl });
    await expect(
      uploadFile(client, {
        projectId: 'p1',
        fileAreaId: 'a1',
        folderId: 'f',
        fileName: 'bad\uD800.txt',
        fileType: 'document',
        contentBase64: Buffer.from('x').toString('base64'),
      }),
    ).rejects.toThrow('fileName');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('downloadFile', () => {
  function streamingClient(size: number) {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array(size), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
    ) as unknown as typeof fetch;
    return new DaluxClient({ apiKey: 'k', fetchImpl });
  }

  const input = { projectId: 'p', fileAreaId: 'a', fileId: 'f', fileRevisionId: 'r' };

  it('applies the server ceiling from DALUX_MAX_DOWNLOAD_BYTES over maxBytes', async () => {
    process.env.DALUX_MAX_DOWNLOAD_BYTES = '16';
    await expect(downloadFile(streamingClient(32), { ...input, maxBytes: 1000 })).rejects.toThrow(
      'exceeds the 16 byte limit',
    );
    const ok = await downloadFile(streamingClient(16), { ...input, maxBytes: 1000 });
    expect(ok).toMatchObject({ sizeBytes: 16, encoding: 'base64', contentType: 'application/pdf' });
  });

  it('rejects an invalid DALUX_MAX_DOWNLOAD_BYTES when the client is created', () => {
    process.env.DALUX_MAX_DOWNLOAD_BYTES = '25MB';
    expect(() => streamingClient(1)).toThrow('DALUX_MAX_DOWNLOAD_BYTES must be an integer');
  });

  it('defaults to a 10 MB limit', async () => {
    delete process.env.DALUX_MAX_DOWNLOAD_BYTES;
    await expect(downloadFile(streamingClient(10 * 1024 * 1024 + 1), input)).rejects.toThrow(
      `exceeds the ${10 * 1024 * 1024} byte limit`,
    );
  });
});
