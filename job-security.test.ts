// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { parseRenderJob, logicalInputHash, publicJob, confinedPath } from './job-contract.js';
import { fetchBounded } from './bounded-fetch.js';
import { jobEnvironment } from './job-environment.js';
import { createJobQueue, atomicWriteJob } from './job-queue.js';
vi.setConfig({ testTimeout: 30_000 });
const fixture = JSON.parse(readFileSync(new URL('./fixtures/render-job-v1.json', import.meta.url), 'utf8'));
const newJob = (digit: number) => ({ job_id: `10000000-0000-4000-a000-${String(digit).padStart(12, '0')}`, project_id: fixture.project_id, step: 'preview', mode: 'preview', index_html: '<html><body>local fixture</body></html>' });
async function boot(root: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['fixtures/job-http-harness.mjs'], { cwd: process.cwd(), env: { ...process.env, WORK_DIR: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = await new Promise<string>((resolve, reject) => { child.stdout!.once('data', chunk => resolve(`http://127.0.0.1:${JSON.parse(String(chunk)).port}`)); child.once('error', reject); child.once('exit', code => reject(new Error(`Fixture exited ${code}`))); });
  return { child, base };
}
async function stop(child: ChildProcess) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
async function waitStatus(base: string, id: string, expected: string) {
  for (let i = 0; i < 200; i++) { const job = await (await fetch(`${base}/${id}`)).json(); if (job.status === expected) return job; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('HTTP state deadline');
}
const submit = (base: string, body: unknown) => fetch(base, { method: 'POST', body: JSON.stringify(body) });

describe('F01 contracts and trust boundary', () => {
  it('consumes exact shared Edge fixture and rejects modified immutable input', () => {
    expect(logicalInputHash(fixture)).toBe(fixture.input_hash);
    expect(parseRenderJob(fixture, 'distinct-dispatch').body.revision).toBe(1);
    expect(() => parseRenderJob({ ...fixture, inputs: { index_html: 'modified' } }, 'distinct-dispatch')).toThrow('INPUT_HASH_MISMATCH');
    expect(() => parseRenderJob(fixture, fixture.callback.secret)).toThrow('INVALID_CALLBACK');
    const publicValue = JSON.stringify(publicJob({ ...fixture, id: fixture.job_id, payload: fixture }));
    expect(publicValue).not.toMatch(/FAKE_CALLBACK_MARKER|FAKE_UPLOAD_MARKER|callback|outputs|inputs/);
  });
  it('accepts preview producer null MP4 refs and rejects unhashed V1 legacy aliases', () => {
    const preview = { ...fixture, step: 'preview', mode: 'preview', artifact_paths: { mp4: null, contact_sheet: fixture.artifact_paths.contact_sheet } };
    preview.input_hash = logicalInputHash(preview);
    expect(parseRenderJob(preview, 'dispatch').body.artifact_paths.mp4).toBeNull();
    expect(() => parseRenderJob({ ...preview, index_html: '<body>unhashed override</body>' }, 'dispatch')).toThrow('INVALID_V1_INPUT_ALIAS');
    expect(() => parseRenderJob({ ...preview, assets: { 'a.png': 'YQ==' } }, 'dispatch')).toThrow('INVALID_V1_INPUT_ALIAS');
  });
  it.each(['../escape', 'a/b', 'a\\b', 'C:\\escape', '/absolute', 'bad;touch', '..', 'foo..mp4'])('rejects asset/path %s', name => {
    expect(() => confinedPath(tmpdir(), name)).toThrow('INVALID_PATH');
    expect(() => parseRenderJob({ ...newJob(10), assets: { [name]: 'YQ==' } }, 'dispatch')).toThrow();
  });
  it('fails closed 503/401 on real /job and rejects invalid UUID before side effects', async () => {
    const previous = { ...process.env }; const root = mkdtempSync(join(tmpdir(), 'f01-auth-'));
    for (const configured of [false, true]) {
      if (configured) process.env.WORKER_SECRET = 'dispatch-fixture'; else delete process.env.WORKER_SECRET;
      process.env.WORK_DIR = root; vi.resetModules();
      const { app } = await import('./server.js'); const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        expect((await fetch(`${base}/job`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(configured ? 401 : 503);
        if (configured) {
          const r = await fetch(`${base}/job`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': 'dispatch-fixture' }, body: JSON.stringify({ ...newJob(11), job_id: '../escape' }) });
          expect(r.status).toBe(400); expect(existsSync(join(root, 'escape'))).toBe(false);
        }
      } finally { await new Promise(resolve => server.close(resolve)); }
    }
    process.env = previous;
  });
  it('passes distinct cache environments to simultaneous actual subprocesses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f01-env-'));
    const original = process.env.HYPERFRAMES_EXTRACT_CACHE_DIR;
    const { spawnCommand } = await import('./server.js');
    const [a, b] = await Promise.all(['a', 'b'].map(id => spawnCommand(process.execPath, ['-e', 'console.log(process.env.HYPERFRAMES_EXTRACT_CACHE_DIR)'], { env: jobEnvironment(join(root, id)) })));
    expect(a.stdout.trim()).toBe(join(root, 'a', '__extract-cache'));
    expect(b.stdout.trim()).toBe(join(root, 'b', '__extract-cache'));
    expect(process.env.HYPERFRAMES_EXTRACT_CACHE_DIR).toBe(original);
    expect(jobEnvironment(join(root, 'a'), { HYPERFRAMES_NO_AUTO_INSTALL: '0' })).toMatchObject({ HYPERFRAMES_NO_AUTO_INSTALL: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1' });
  });
});

describe('F01 queue via actual HTTP processes', () => {
  it('halts admission and skips execution when the durable running transition fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f01-storage-failure-')); const jobs = new Map(); const processJob = vi.fn();
    let writes = 0;
    const queue = createJobQueue({ root, jobs, processJob, writeJob: job => { if (++writes > 1) throw new Error('private filesystem diagnostic'); atomicWriteJob(job); } });
    expect(queue.accept(newJob(21), 'hash').status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(processJob).not.toHaveBeenCalled(); expect(queue.stats()).toMatchObject({ active: 0, storage_available: false });
    expect(queue.accept(newJob(22), 'hash').status).toBe(503);
    expect(JSON.parse(readFileSync(join(root, newJob(21).job_id, 'job-state-v1.json'), 'utf8')).status).toBe('queued');
  });
  it('persists callback transport failure and releases the queue slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f01-callback-throw-')); const jobs = new Map();
    const queue = createJobQueue({ root, jobs, concurrency: 1, processJob: async body => { jobs.get(body.job_id).status = 'done'; }, deliverCallback: async () => { throw new Error('FAKE_PRIVATE_MARKER'); } });
    queue.accept(newJob(23), 'hash'); queue.accept(newJob(24), 'hash');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(queue.stats()).toMatchObject({ active: 0, queued: 0, storage_available: true });
    for (const digit of [23, 24]) {
      const saved = JSON.parse(readFileSync(join(root, newJob(digit).job_id, 'job-state-v1.json'), 'utf8'));
      expect(saved.callback_status).toMatchObject({ ok: false, error: 'CALLBACK_TRANSPORT_FAILED' }); expect(JSON.stringify(saved)).not.toContain('FAKE_PRIVATE_MARKER');
    }
  });
  it('bounds concurrency/capacity and preserves queued/running/terminal on process restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f01-restart-')); let worker = await boot(root, { FIXTURE_DELAY_MS: '1500' });
    const a = newJob(1), b = newJob(2), c = newJob(3);
    try {
      expect((await submit(worker.base, a)).status).toBe(202); await waitStatus(worker.base, a.job_id, 'running');
      expect((await submit(worker.base, b)).status).toBe(202);
      expect((await submit(worker.base, a)).status).toBe(200);
      expect((await submit(worker.base, { ...a, index_html: 'different' })).status).toBe(409);
      expect((await submit(worker.base, c)).status).toBe(429);
      expect(await (await fetch(`${worker.base}/stats`)).json()).toMatchObject({ active: 1, queued: 1 });
      await stop(worker.child); worker = await boot(root);
      expect(await waitStatus(worker.base, a.job_id, 'failed')).toMatchObject({ error_code: 'WORKER_RESTART_INTERRUPTED' });
      await waitStatus(worker.base, b.job_id, 'done');
      await stop(worker.child); worker = await boot(root);
      await waitStatus(worker.base, a.job_id, 'failed'); await waitStatus(worker.base, b.job_id, 'done');
      expect((await submit(worker.base, b)).status).toBe(200);
      expect(readFileSync(join(root, 'executions.txt'), 'utf8').trim().split('\n')).toEqual([a.job_id, b.job_id]);
    } finally { await stop(worker.child); }
  });
  it('retries terminal callback after restart without re-execution', async () => {
    let status = 503, attempts = 0;
    const callback = http.createServer((_req, res) => { attempts++; res.writeHead(status); res.end(); });
    await new Promise<void>(resolve => callback.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(callback.address() as { port: number }).port}`;
    const root = mkdtempSync(join(tmpdir(), 'f01-callback-')); let worker = await boot(root, { FIXTURE_CALLBACK_URL: url }); const a = newJob(4);
    try {
      await submit(worker.base, a); await waitStatus(worker.base, a.job_id, 'done');
      for (let i = 0; i < 100 && attempts === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
      await stop(worker.child); status = 200; worker = await boot(root, { FIXTURE_CALLBACK_URL: url });
      for (let i = 0; i < 100 && attempts < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(attempts).toBe(2); expect(readFileSync(join(root, 'executions.txt'), 'utf8').trim()).toBe(a.job_id);
    } finally { await stop(worker.child); await new Promise(resolve => callback.close(resolve)); }
  });
});

describe('F01 bounded streaming', () => {
  it('omits private strings and absolute local paths from nested public diagnostics', () => {
    const publicValue = publicJob({ id: fixture.job_id, project_id: fixture.project_id, timings: { render: 12, secret: 'FAKE_PRIVATE_MARKER', nested: { secret: 'FAKE_PRIVATE_MARKER' } }, uploaded: { mp4: '/tmp/private.mp4', composition_html: `projects/${fixture.project_id}/compositions/index.html`, snapshots: true }, output: { mp4_url: 'C:\\private.mp4', mp4_size_bytes: 15 } });
    expect(publicValue.timings).toEqual({ render: 12 }); expect(publicValue.uploaded).toEqual({ composition_html: `projects/${fixture.project_id}/compositions/index.html`, snapshots: true });
    expect(publicValue.output).toEqual({ mp4_size_bytes: 15 }); expect(JSON.stringify(publicValue)).not.toMatch(/FAKE_PRIVATE_MARKER|private.mp4/);
  });
  it('caps chunked bytes and slow body after headers across the full deadline', async () => {
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((req, res) => { res.writeHead(200); res.flushHeaders(); if (req.url === '/big') res.end(Buffer.alloc(1024)); });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await expect(fetchBounded(`${base}/big`, { maxBytes: 100, timeoutMs: 300 })).rejects.toThrow('DOWNLOAD_BYTES_LIMIT');
      const start = Date.now(); await expect(fetchBounded(`${base}/slow`, { timeoutMs: 100 })).rejects.toThrow('DOWNLOAD_DEADLINE'); expect(Date.now() - start).toBeLessThan(1000);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  });
});
