// @vitest-environment node
/**
 * server.contract.test.ts — V4-1 TDD §8: worker contract tests
 *
 * Covers: health; job payload validation; fixture staging + callback with
 * secret; linkedom patch (R5) on fixture HTML; preview HMAC auth rejects
 * invalid/expired tokens. No HyperFrames CLI is invoked (mode 'preview').
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createWorkerApp, validateJobPayload } from './server.js';
import { createPreviewToken } from './preview-token.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREVIEW_SECRET = 'test-preview-secret';

let server: http.Server;
let base: string;
let workDir: string;
let callbackServer: http.Server;
let callbackBase: string;
const callbacks: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validJob(overrides: Record<string, unknown> = {}) {
  return {
    job_id: `job-${Math.random().toString(36).slice(2, 10)}`,
    project_id: 'proj-fixture-1',
    mode: 'preview',
    step: 'build',
    inputs: { fixture: 'pj-launch' },
    outputs: {},
    options: { quality: 'high', fps: 30 },
    callback: { url: `${callbackBase}/cb`, secret: 'cb-secret-123' },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'vp-worker-test-'));

  callbackServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      callbacks.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => callbackServer.listen(0, '127.0.0.1', r));
  callbackBase = `http://127.0.0.1:${(callbackServer.address() as { port: number }).port}`;

  const { app } = createWorkerApp({
    workDir,
    fixturesDir: join(__dirname, 'fixtures'),
    previewSecret: PREVIEW_SECRET,
    workers: 1,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => callbackServer.close(r));
  rmSync(workDir, { recursive: true, force: true });
});

describe('GET /health', () => {
  it('devolve ok com workers=1', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.workers).toBe(1);
    expect(typeof body.ts).toBe('number');
  });
});

describe('POST /job — validação', () => {
  it('rejeita payload sem job_id/project_id/callback', async () => {
    const res = await post('/job', { project_id: 'p', mode: 'render' });
    expect(res.status).toBe(400);
  });

  it('rejeita mode inválido', async () => {
    const res = await post('/job', validJob({ mode: 'explode' }));
    expect(res.status).toBe(400);
  });

  it('rejeita sem inputs.index_html_url nem fixture', async () => {
    const res = await post('/job', validJob({ inputs: {} }));
    expect(res.status).toBe(400);
  });

  it('validateJobPayload aceita contrato completo', () => {
    expect(validateJobPayload(validJob())).toBeNull();
  });

  it('rejeita nome de fixture com path traversal', async () => {
    const res = await post('/job', validJob({ inputs: { fixture: '../etc' } }));
    expect(res.status).toBe(400);
  });
});

describe('job lifecycle (fixture mode)', () => {
  it('aceita job, faz stage da fixture e chama callback com secret', async () => {
    const job = validJob();
    const res = await post('/job', job);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ job_id: job.job_id, status: 'queued' });

    await waitFor(() => callbacks.some((c) => c.body.job_id === job.job_id));
    const cb = callbacks.find((c) => c.body.job_id === job.job_id)!;
    expect(cb.headers['x-worker-secret']).toBe('cb-secret-123');
    expect(cb.body.status).toBe('done');
    expect(cb.body.project_id).toBe('proj-fixture-1');
    expect(typeof cb.body.timings.stage_ms).toBe('number');
    expect(cb.body.tokens).toEqual({ llm_input: 0, llm_output: 0 });

    // index.html da fixture ficou em stage no workdir
    const html = readFileSync(join(workDir, job.job_id, 'index.html'), 'utf-8');
    expect(html).toContain('data-composition-id="main"');
  });

  it('duplicar job_id devolve 409', async () => {
    const job = validJob({ job_id: 'job-dup' });
    expect((await post('/job', job)).status).toBe(202);
    await waitFor(() => callbacks.some((c) => c.body.job_id === 'job-dup'));
    expect((await post('/job', job)).status).toBe(409);
  });
});

describe('GET /job/:id/status', () => {
  it('devolve estado e NUNCA o callback secret', async () => {
    const job = validJob({ job_id: 'job-status' });
    await post('/job', job);
    await waitFor(() => callbacks.some((c) => c.body.job_id === 'job-status'));
    const res = await fetch(`${base}/job/job-status/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('done');
    expect(JSON.stringify(body)).not.toContain('cb-secret-123');
  });

  it('404 para job inexistente', async () => {
    expect((await fetch(`${base}/job/nope/status`)).status).toBe(404);
  });
});

describe('POST /job/:id/patch — linkedom (R5)', () => {
  it('faz patch de #id no HTML da fixture e reflete no ficheiro', async () => {
    const job = validJob({ job_id: 'job-patch' });
    await post('/job', job);
    await waitFor(() => callbacks.some((c) => c.body.job_id === 'job-patch'));

    const res = await post('/job/job-patch/patch', { selector: '#s1-brand .brand-name', text: 'x' });
    expect(res.status).toBe(400); // só #id e [data-edit] são suportados

    const ok = await post('/job/job-patch/patch', { selector: '#s1-brand', text: 'PORTUGAL JEWELS ✦' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, patched: '#s1-brand' });

    const html = readFileSync(join(workDir, 'job-patch', 'index.html'), 'utf-8');
    expect(html).toContain('PORTUGAL JEWELS ✦');
  });

  it('400 para selector fora da whitelist (classes)', async () => {
    const res = await post('/job/job-patch/patch', { selector: '.brand-name', text: 'x' });
    expect(res.status).toBe(400);
  });

  it('404 quando o selector não existe na composição', async () => {
    const job = validJob({ job_id: 'job-patch-404' });
    await post('/job', job);
    await waitFor(() => callbacks.some((c) => c.body.job_id === 'job-patch-404'));
    const res = await post('/job/job-patch-404/patch', { selector: '#nao-existe', text: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('GET /preview/:id — auth HMAC', () => {
  it('serve o index.html com token válido', async () => {
    const job = validJob({ job_id: 'job-preview' });
    await post('/job', job);
    await waitFor(() => callbacks.some((c) => c.body.job_id === 'job-preview'));

    const token = createPreviewToken('proj-fixture-1', PREVIEW_SECRET);
    const res = await fetch(`${base}/preview/proj-fixture-1?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-composition-id="main"');
  });

  it('rejeita token expirado', async () => {
    const token = createPreviewToken('proj-fixture-1', PREVIEW_SECRET, { ttlMs: -1000 });
    const res = await fetch(`${base}/preview/proj-fixture-1?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
  });

  it('rejeita ausência de token', async () => {
    const res = await fetch(`${base}/preview/proj-fixture-1`);
    expect(res.status).toBe(401);
  });

  it('rejeita token assinado para outro projeto', async () => {
    const token = createPreviewToken('outro-projeto', PREVIEW_SECRET);
    const res = await fetch(`${base}/preview/proj-fixture-1?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
  });
});
