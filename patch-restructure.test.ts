// @vitest-environment node
/**
 * patch-restructure.test.ts — V4-04C: project-scoped write endpoints
 *
 * Covers:
 * 1. POST /patch/:id — linkedom application (textContent/src/bg-image/x/y),
 *    persistence to {job_dir}/index.html, patched HTML in the response.
 * 2. POST /restructure/:id — cumulative data-start, data-duration from
 *    durationFrames/fps, removal of vanished clips, root data-duration.
 * 3. Auth matrix: X-Worker-Secret ok; bad secret 401; no secrets 503;
 *    preview HMAC token accepted.
 * 4. Validation: non-#id selector → 400; empty patches → 400; unknown
 *    project → 404.
 * 5. GET /healthz — liveness with uptime + active jobs.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { app } from './server.js';
import { createPreviewToken } from './preview-token.js';

const COMPOSITION_HTML = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="12" data-width="1080" data-height="1920">
  <h1 id="text-headline-1" style="color: #ffffff; font-size: 48px;">Hello</h1>
  <img id="img-hero" src="assets/hero.jpg" />
  <div id="scene-1" class="clip" data-start="0" data-duration="6" data-track-index="0"></div>
  <div id="scene-2" class="clip" data-start="6" data-duration="6" data-track-index="0"></div>
  <div id="scene-3" class="clip" data-start="12" data-duration="6" data-track-index="0"></div>
</div>
</body>
</html>`;

const SECRET = 'test-worker-secret';

let server: http.Server;
let base: string;

const workerApp = app as unknown as {
  listen: (port: number, host: string) => http.Server;
};

async function stage(projectId: string) {
  const res = await fetch(`${base}/job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: `job-${projectId}`,
      project_id: projectId,
      mode: 'preview',
      index_html: COMPOSITION_HTML,
    }),
  });
  expect(res.status).toBe(200);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.WORKER_SECRET = SECRET;
  delete process.env.PREVIEW_SECRET;
  vi.resetModules();
  const mod = (await import('./server.js')) as unknown as {
    app: { listen: (port: number, host: string) => http.Server };
  };
  server = mod.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.WORKER_SECRET;
});

describe('POST /patch/:id — V4-04C', () => {
  it('applies patches via linkedom and returns the patched HTML', async () => {
    await stage('proj-patch-1');
    const res = await post(
      '/patch/proj-patch-1',
      {
        patches: [
          { selector: '#text-headline-1', property: 'textContent', value: 'Novo texto' },
          { selector: '#text-headline-1', property: 'size', value: '72' },
          { selector: '#img-hero', property: 'src', value: 'assets/new.jpg' },
          { selector: '#scene-1', property: 'background-image', value: 'https://cdn/bg.jpg' },
          { selector: '#scene-2', property: 'x', value: '120' },
        ],
      },
      { 'X-Worker-Secret': SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: number; html: string };
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(5);
    // Patched HTML rides on the response…
    expect(body.html).toContain('Novo texto');
    expect(body.html).toContain('font-size: 72px');
    expect(body.html).toContain('src="assets/new.jpg"');
    expect(body.html).toContain('url(https://cdn/bg.jpg)');
    expect(body.html).toContain('left: 120px');
    // …and is persisted (served back on the preview).
    const preview = await fetch(`${base}/preview/proj-patch-1`);
    const html = await preview.text();
    expect(html).toContain('Novo texto');
  });

  it('401 with a wrong service secret (preview secret unset)', async () => {
    await stage('proj-patch-auth');
    const res = await post('/patch/proj-patch-auth', { patches: [{ selector: '#x', property: 'color', value: 'red' }] }, {
      'X-Worker-Secret': 'wrong',
    });
    expect(res.status).toBe(401);
  });

  it('400 for a non-#id selector', async () => {
    await stage('proj-patch-sel');
    const res = await post(
      '/patch/proj-patch-sel',
      { patches: [{ selector: '.clip', property: 'color', value: 'red' }] },
      { 'X-Worker-Secret': SECRET },
    );
    expect(res.status).toBe(400);
  });

  it('400 for an empty patches array', async () => {
    await stage('proj-patch-empty');
    const res = await post('/patch/proj-patch-empty', { patches: [] }, { 'X-Worker-Secret': SECRET });
    expect(res.status).toBe(400);
  });

  it('404 for an unknown project', async () => {
    const res = await post(
      '/patch/nao-existe',
      { patches: [{ selector: '#x', property: 'color', value: 'red' }] },
      { 'X-Worker-Secret': SECRET },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /restructure/:id — V4-04C', () => {
  it('rewrites durations, recomputes cumulative starts and removes vanished clips', async () => {
    await stage('proj-restr-1');
    const res = await post(
      '/restructure/proj-restr-1',
      {
        scenes: [
          { id: 'scene-3', durationFrames: 90 }, // moved first, 3s
          { id: 'scene-1', durationFrames: 150 }, // 5s
        ],
        fps: 30,
      },
      { 'X-Worker-Secret': SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: number; removed: string[]; html: string };
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(2);
    expect(body.removed).toEqual(['scene-2']);

    // scene-3 now starts at 0 with 3s; scene-1 at 3s with 5s; root = 8s.
    expect(body.html).toMatch(/id="scene-3"[^>]*data-start="0"[^>]*data-duration="3"/s);
    expect(body.html).toMatch(/id="scene-1"[^>]*data-start="3"[^>]*data-duration="5"/s);
    expect(body.html).not.toMatch(/id="scene-2"/);
    expect(body.html).toMatch(/data-composition-id="main"[^>]*data-duration="8"/s);

    // Persisted: the preview serves the restructured composition.
    const preview = await fetch(`${base}/preview/proj-restr-1`);
    expect(await preview.text()).not.toContain('id="scene-2"');
  });

  it('400 when scenes is empty or malformed', async () => {
    await stage('proj-restr-bad');
    const empty = await post('/restructure/proj-restr-bad', { scenes: [] }, { 'X-Worker-Secret': SECRET });
    expect(empty.status).toBe(400);
    const malformed = await post(
      '/restructure/proj-restr-bad',
      { scenes: [{ id: 'scene-1' }] },
      { 'X-Worker-Secret': SECRET },
    );
    expect(malformed.status).toBe(400);
  });

  it('accepts the preview HMAC token as auth (Spec C §2.1)', async () => {
    process.env.PREVIEW_SECRET = SECRET;
    vi.resetModules();
    const mod = (await import('./server.js')) as unknown as {
      app: { listen: (port: number, host: string) => http.Server };
    };
    const srv = mod.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const altBase = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const stageRes = await fetch(`${altBase}/job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: 'job-token-w', project_id: 'proj-token-w', mode: 'preview', index_html: COMPOSITION_HTML }),
      });
      expect(stageRes.status).toBe(200);

      const noAuth = await fetch(`${altBase}/patch/proj-token-w`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patches: [{ selector: '#img-hero', property: 'src', value: 'a.jpg' }] }),
      });
      expect(noAuth.status).toBe(401);

      const token = createPreviewToken('proj-token-w', SECRET);
      const ok = await fetch(`${altBase}/patch/proj-token-w?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patches: [{ selector: '#img-hero', property: 'src', value: 'b.jpg' }] }),
      });
      expect(ok.status).toBe(200);
    } finally {
      await new Promise((r) => srv.close(r));
      delete process.env.PREVIEW_SECRET;
      vi.resetModules();
    }
  });

  it('503 when neither WORKER_SECRET nor PREVIEW_SECRET is configured', async () => {
    delete process.env.WORKER_SECRET;
    delete process.env.PREVIEW_SECRET;
    vi.resetModules();
    const mod = (await import('./server.js')) as unknown as {
      app: { listen: (port: number, host: string) => http.Server };
    };
    const srv = mod.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const altBase = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const stageRes = await fetch(`${altBase}/job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: 'job-noauth', project_id: 'proj-noauth', mode: 'preview', index_html: COMPOSITION_HTML }),
      });
      expect(stageRes.status).toBe(200);
      const res = await fetch(`${altBase}/patch/proj-noauth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patches: [{ selector: '#img-hero', property: 'src', value: 'a.jpg' }] }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'auth_not_configured' });
    } finally {
      await new Promise((r) => srv.close(r));
      vi.resetModules();
    }
  });
});

describe('GET /healthz — V4-04D §2.5', () => {
  it('reports uptime and active jobs', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; uptime_s: number; active_jobs: number };
    expect(body.ok).toBe(true);
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    expect(body.active_jobs).toBeGreaterThan(0);
  });
});
