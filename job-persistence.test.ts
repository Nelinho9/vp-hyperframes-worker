import { fixtureFetch as fetch, fixtureId } from "./test-http-fixture";
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
  '5097f9f1-20b0-4ec4-24b9-0f7f0101aa9d',
  { job_id: '5097f9f1-20b0-4ec4-24b9-0f7f0101aa9d', project_id: 'efbdd250-6920-2eff-f397-55ec9d07d227', step: 'preview', mode: 'preview', created_at: '2026-08-17T10:00:00.000Z' },
  '<!doctype html><html><body>placeholder-rehydrated</body></html>',
);
// Marker without index.html → must be skipped.
seedJob('89245d0c-2395-8287-9337-f28cf9dff201', { job_id: '89245d0c-2395-8287-9337-f28cf9dff201', project_id: '48b338d7-f533-e3b4-94ab-91c0f2895539', step: 'build', mode: 'preview', created_at: '2026-08-17T11:00:00.000Z' });
// Two jobs for the same project: placeholder (older) + real build (newer).
seedJob(
  'a2794f38-babc-64e0-1068-1bf7aeb2d5e9',
  { job_id: 'a2794f38-babc-64e0-1068-1bf7aeb2d5e9', project_id: '7237a603-6983-98a7-6828-92dd30d255a5', step: 'preview', mode: 'preview', created_at: '2026-08-17T10:00:00.000Z' },
  '<!doctype html><html><body>placeholder-multi</body></html>',
);
seedJob(
  'build-job-multi',
  { job_id: 'build-job-multi', project_id: '7237a603-6983-98a7-6828-92dd30d255a5', step: 'build', mode: 'render', created_at: '2026-08-17T12:00:00.000Z' },
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
    const res = await fetch(`${base}/preview/efbdd250-6920-2eff-f397-55ec9d07d227`);
    expect([200, 202]).toContain(res.status);
    expect(await res.text()).toContain('placeholder-rehydrated');
  });

  it('skips dirs whose marker has no index.html', async () => {
    const res = await fetch(`${base}/preview/48b338d7-f533-e3b4-94ab-91c0f2895539`);
    expect(res.status).toBe(404);
  });

  it('latest created_at wins when multiple jobs share a project_id', async () => {
    const res = await fetch(`${base}/preview/7237a603-6983-98a7-6828-92dd30d255a5`);
    expect([200, 202]).toContain(res.status);
    expect(await res.text()).toContain('real-composition-multi');
  });
});

describe('placeholder staging flow (V4-3g.3)', () => {
  it('POST /job with mode preview stages immediately and writes job.json', async () => {
    const placeholder = '<!doctype html><html><body>A preparar o preview…</body></html>';
    const res = await post('/job', {
      job_id: 'c91832d9-a0ca-b92b-69ee-ada4befa0686',
      project_id: '14f6f978-646a-e5da-f1b7-e1b1129f8bb5',
      step: 'preview',
      mode: 'preview',
      index_html: placeholder,
    });
    expect([200, 202]).toContain(res.status);

    const preview = await fetch(`${base}/preview/14f6f978-646a-e5da-f1b7-e1b1129f8bb5`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('A preparar o preview');

    // Marker persisted for boot rehydration.
    const markerPath = join(workDir, 'c91832d9-a0ca-b92b-69ee-ada4befa0686', 'job.json');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(marker).toMatchObject({ job_id: 'c91832d9-a0ca-b92b-69ee-ada4befa0686', project_id: '14f6f978-646a-e5da-f1b7-e1b1129f8bb5', mode: 'preview' });
  });

  it('a later job for the same project_id overwrites the preview mapping', async () => {
    const real = '<!doctype html><html><body>real-build-content</body></html>';
    const res = await post('/job', {
      job_id: '673c2292-ba01-995f-65cf-ef26c0022e98',
      project_id: '14f6f978-646a-e5da-f1b7-e1b1129f8bb5',
      step: 'build',
      mode: 'preview', // staged (no CLI) — overwrite semantics are mode-independent
      index_html: real,
    });
    expect([200, 202]).toContain(res.status);

    const preview = await fetch(`${base}/preview/14f6f978-646a-e5da-f1b7-e1b1129f8bb5`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain('real-build-content');
    expect(html).not.toContain('A preparar o preview');
  });

  it('re-staging with the same deterministic job_id is idempotent', async () => {
    const placeholder = '<!doctype html><html><body>placeholder-v2</body></html>';
    const first = await post('/job', {
      job_id: '1f2afff1-83da-6847-246f-904129e83dac',
      project_id: '0303418b-419c-4ece-f77f-a1bf0042ad88',
      step: 'preview',
      mode: 'preview',
      index_html: placeholder,
    });
    expect([200, 202]).toContain(first.status);
    const second = await post('/job', {
      job_id: '1f2afff1-83da-6847-246f-904129e83dac',
      project_id: '0303418b-419c-4ece-f77f-a1bf0042ad88',
      step: 'preview',
      mode: 'preview',
      index_html: placeholder,
    });
    expect(second.status).toBe(200);

    const preview = await fetch(`${base}/preview/0303418b-419c-4ece-f77f-a1bf0042ad88`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('placeholder-v2');
  });
});
