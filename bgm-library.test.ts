// @vitest-environment node
/**
 * bgm-library.test.ts — V5-P5B §2.1: a biblioteca BGM curated é vendida pelo
 * worker (catálogo + ficheiros) com os mesmos guardrails das rotas /runtime.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from './server.js';

const BGM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'bgm');

let server: http.Server;
let base: string;

const workerApp = app as unknown as {
  listen: (port: number, host: string) => http.Server;
};

beforeAll(async () => {
  server = workerApp.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('GET /bgm/catalog.json', () => {
  it('serve o catálogo com CORS aberto', async () => {
    const res = await fetch(`${base}/bgm/catalog.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const catalog = (await res.json()) as { version: number; tracks: Array<{ id: string; file: string }> };
    expect(catalog.version).toBeGreaterThanOrEqual(1);
    expect(catalog.tracks.length).toBeGreaterThanOrEqual(12);
  });
});

describe('GET /bgm/:file', () => {
  it('serve uma faixa existente como audio/mpeg', async () => {
    const first = JSON.parse(readFileSync(join(BGM_DIR, 'catalog.json'), 'utf8')) as {
      tracks: Array<{ file: string }>;
    };
    const file = first.tracks[0].file;
    const res = await fetch(`${base}/bgm/${file}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(10_000);
    // ID3/mp3 magic
    expect(buf[0] === 0x49 || buf[0] === 0xff).toBe(true);
  });

  it('404 para faixa inexistente', async () => {
    const res = await fetch(`${base}/bgm/nao-existe.mp3`);
    expect(res.status).toBe(404);
  });

  it('rejeita extensões fora da whitelist e traversal', async () => {
    const resScript = await fetch(`${base}/bgm/server.js`);
    expect(resScript.status).toBe(404);
    const resTraversal = await fetch(
      `${base}/bgm/%2E%2E%2Fpackage.json`,
    );
    expect([400, 404]).toContain(resTraversal.status);
  });
});
