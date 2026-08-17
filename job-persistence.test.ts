// @vitest-environment node
/**
 * job-persistence.test.ts — V4-3g.3 (B6): preview registry survives restarts
 *
 * Covers:
 * 1. POST /job writes a job.json marker into the job dir.
 * 2. Boot rehydration: WORK_DIR scan repopulates jobs/projectJobs so
 *    GET /preview/:id keeps serving after a restart (module re-import).
 *    Dirs without index.html (or without marker) are skipped.
 * 3. Placeholder staging flow: mode 'preview' with a deterministic
 *    job_id (preview-<project>) stages immediately; a later build job for
 *    the same project_id overwrites the preview mapping.
 * 4. Multiple jobs per project on disk: the most recent created_at wins.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Seed a WORK_DIR BEFORE importing server.js (boot scan runs at import) ──
const workDir = mkdtempSync(join(tmpdir(), 'worker-boot-'));

function seedJob(dir: string, marker: Record<string, unknown>, html?: string) {
  const jobDir = join(workDir, dir);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify(marker));
  if (html !== undefined) writeFileSync(join(jobDir, 'index.html'), html);
}

// Staged placeholder from a previous "boot".
seedJob(
  'preview-proj-rehydrated',
  { job_id: 'preview-proj-rehydrated', project_id: 'proj-rehydrated', step: 'preview', mode: 'preview', created_at: '2026-08-17T10:00:00.000Z' },
  '<!doctype html><html><body>placeholder-rehydrated</body></html>',
);
// Marker without index.html → must be skipped.
seedJob('job-broken-1', { job_id: 'job-broken-1', project_id: 'proj-broken', step: 'build', mode: 'preview', created_at: '2026-08-17T11:00:00.000Z' });
// Two jobs for the same project: placeholder (older) + real build (newer).
seedJob(
  'preview-proj-multi',
  { job_id: 'preview-proj-multi', project_id: 'proj-multi', step: 'preview', mode: 'preview', created_at: '2026-08-17T10:00:00.000Z' },
  '<!doctype html><html><body>placeholder-multi</body></html>',
);
seedJob(
  'build-job-multi',
  { job_id: 'build-job-multi', project_id: 'proj-multi', step: 'build', mode: 'render', created_at: '2026-08-17T12:00:00.000Z' },
  '<!doctype html><html><body>real-composition-multi</body></html>',
);

process.env.WORK_DIR = workDir;

const { app } = (await import('./server.js')) as unknown as {
  app: { listen: (port: number, host: string) => http.Server };
};

let server: http.Server;
let base: string;

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(workDir, { recursive: true, force: true });
});

describe('boot rehydration (V4-3g.3)', () => {
  it('serves a preview whose job.json + index.html existed before boot', async () => {
    const res = await fetch(`${base}/preview/proj-rehydrated`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('placeholder-rehydrated');
  });

  it('skips dirs whose marker has no index.html', async () => {
    const res = await fetch(`${base}/preview/proj-broken`);
    expect(res.status).toBe(404);
  });

  it('latest created_at wins when multiple jobs share a project_id', async () => {
    const res = await fetch(`${base}/preview/proj-multi`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('real-composition-multi');
  });
});

describe('placeholder staging flow (V4-3g.3)', () => {
  it('POST /job with mode preview stages immediately and writes job.json', async () => {
    const placeholder = '<!doctype html><html><body>A preparar o preview…</body></html>';
    const res = await post('/job', {
      job_id: 'preview-proj-stage',
      project_id: 'proj-stage',
      step: 'preview',
      mode: 'preview',
      index_html: placeholder,
    });
    expect(res.status).toBe(200);

    const preview = await fetch(`${base}/preview/proj-stage`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('A preparar o preview');

    // Marker persisted for boot rehydration.
    const markerPath = join(workDir, 'preview-proj-stage', 'job.json');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(marker).toMatchObject({ job_id: 'preview-proj-stage', project_id: 'proj-stage', mode: 'preview' });
  });

  it('a later job for the same project_id overwrites the preview mapping', async () => {
    const real = '<!doctype html><html><body>real-build-content</body></html>';
    const res = await post('/job', {
      job_id: 'build-proj-stage',
      project_id: 'proj-stage',
      step: 'build',
      mode: 'preview', // staged (no CLI) — overwrite semantics are mode-independent
      index_html: real,
    });
    expect(res.status).toBe(200);

    const preview = await fetch(`${base}/preview/proj-stage`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain('real-build-content');
    expect(html).not.toContain('A preparar o preview');
  });

  it('re-staging with the same deterministic job_id is idempotent', async () => {
    const placeholder = '<!doctype html><html><body>placeholder-v2</body></html>';
    const first = await post('/job', {
      job_id: 'preview-proj-idem',
      project_id: 'proj-idem',
      step: 'preview',
      mode: 'preview',
      index_html: placeholder,
    });
    expect(first.status).toBe(200);
    const second = await post('/job', {
      job_id: 'preview-proj-idem',
      project_id: 'proj-idem',
      step: 'preview',
      mode: 'preview',
      index_html: placeholder,
    });
    expect(second.status).toBe(200);

    const preview = await fetch(`${base}/preview/proj-idem`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('placeholder-v2');
  });
});
