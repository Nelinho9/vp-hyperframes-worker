// @vitest-environment node
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { uploadToSignedUrl } from './server.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('uploadToSignedUrl', () => {
  it('faz PUT do artefacto com content type', async () => {
    let method = '';
    let contentType = '';
    let body = '';
    const server = createServer((req, res) => {
      method = req.method ?? '';
      contentType = req.headers['content-type'] ?? '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };

    await uploadToSignedUrl(`http://127.0.0.1:${address.port}/upload`, Buffer.from('mp4-bytes'), 'video/mp4');

    expect(method).toBe('PUT');
    expect(contentType).toBe('video/mp4');
    expect(body).toBe('mp4-bytes');
  });

  it('expõe o erro do storage quando o PUT falha', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end('storage unavailable');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };

    await expect(uploadToSignedUrl(`http://127.0.0.1:${address.port}/upload`, Buffer.from('x'), 'video/mp4'))
      .rejects.toThrow('signed upload failed (500): storage unavailable');
  });
});
