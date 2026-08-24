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
import { parseHTML } from 'linkedom';
import { normalizeClipWindows } from './patch-engine.js';
import { lintClipWindows } from './window-lint.js';

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
    // V5-P0B (AD-1): x is a translate DELTA var — no left/top literals.
    expect(body.html).toMatch(/--el-x:\s*120px/);
    expect(body.html).toContain('translate: var(--el-x, 0px) var(--el-y, 0px)');
    expect(body.html).not.toContain('left: 120px');
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

describe('POST /patch/:id — geometria V5-P0B (AD-1)', () => {
  const GEOM_HTML = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div data-composition-id="main" data-start="0" data-duration="6">
  <h1 id="headline-1" style="position: absolute; left: 340px; top: 80px;">H</h1>
  <img id="img-hero" src="assets/hero.jpg" style="width: 400px;" />
</div>
</body>
</html>`;

  async function stageGeom(projectId: string) {
    const res = await fetch(`${base}/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: `job-${projectId}`, project_id: projectId, mode: 'preview', index_html: GEOM_HTML }),
    });
    expect(res.status).toBe(200);
  }

  it('converte x/y absolutos em DELTA vs left/top authored e nunca escreve left/top', async () => {
    await stageGeom('proj-geom-1');
    const res = await post(
      '/patch/proj-geom-1',
      {
        patches: [
          { selector: '#headline-1', property: 'x', value: '100' },
          { selector: '#headline-1', property: 'y', value: '60' },
        ],
      },
      { 'X-Worker-Secret': SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; html: string };

    // Delta semantics: desired − authored baseline.
    expect(body.html).toMatch(/--el-x:\s*-240px/);
    expect(body.html).toMatch(/--el-y:\s*-20px/);
    // Individual-transform consumption, exactly once.
    expect(body.html.match(/translate\s*:/g)?.length).toBe(1);
    // Authored origin untouched — no NEW layout literals.
    expect(body.html.match(/\bleft\s*:/g)?.length).toBe(1);
    expect(body.html).toContain('left: 340px');
    expect(body.html.match(/\btop\s*:/g)?.length).toBe(1);

    // Persisted for the preview/render path.
    const preview = await fetch(`${base}/preview/proj-geom-1`);
    expect(await preview.text()).toMatch(/--el-x:\s*-240px/);
  });

  it('width/height são absolutos (--el-w/--el-h + consumo que substitui o authored)', async () => {
    await stageGeom('proj-geom-2');
    const res = await post(
      '/patch/proj-geom-2',
      {
        patches: [
          { selector: '#img-hero', property: 'width', value: '420' },
          { selector: '#img-hero', property: 'height', value: '280' },
        ],
      },
      { 'X-Worker-Secret': SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; html: string };
    expect(body.html).toMatch(/--el-w:\s*420px/);
    expect(body.html).toMatch(/--el-h:\s*280px/);
    // Consumption replaces the authored width decl (no duplicates).
    expect(body.html).toContain('width: var(--el-w)');
    expect(body.html).toContain('height: var(--el-h)');
    expect(body.html.match(/\bwidth\s*:/g)?.length).toBe(1);
  });

  it('re-patch converge para o mesmo estado (idempotente)', async () => {
    await stageGeom('proj-geom-3');
    const patches = {
      patches: [
        { selector: '#headline-1', property: 'x', value: '180' },
        { selector: '#headline-1', property: 'y', value: '90' },
      ],
    };
    const once = await post('/patch/proj-geom-3', patches, { 'X-Worker-Secret': SECRET });
    const twice = await post('/patch/proj-geom-3', patches, { 'X-Worker-Secret': SECRET });
    const a = ((await once.json()) as { html: string }).html;
    const b = ((await twice.json()) as { html: string }).html;

    expect(b).toMatch(/--el-x:\s*-160px/);
    expect(b).toMatch(/--el-y:\s*10px/);
    // Second application is byte-identical to the first (fully converged).
    expect(b.replace(/\s+/g, ' ')).toBe(a.replace(/\s+/g, ' '));
    // The authored left/top were never rewritten as deltas.
    expect(b).toContain('left: 340px');
  });

  it('rotation escreve --el-rotate com consumo rotate()', async () => {
    await stageGeom('proj-geom-4');
    const res = await post(
      '/patch/proj-geom-4',
      { patches: [{ selector: '#img-hero', property: 'rotation', value: '-12.5' }] },
      { 'X-Worker-Secret': SECRET },
    );
    const body = (await res.json()) as { ok: boolean; html: string };
    expect(body.html).toMatch(/--el-rotate:\s*-12\.5deg/);
    expect(body.html).toContain('rotate: var(--el-rotate, 0deg)');
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

// ── V5-P0C: seek determinism (frame-exact windows) ───────────────────────────

/** Parse the served top-level clip windows exactly like the runtime does.
 *  Clips without a usable numeric window are skipped (no timeline presence). */
function extractWindows(html: string): Array<{ id: string; start: number; end: number }> {
  const { document } = parseHTML(html);
  const rootEl = document.querySelector('[data-composition-id]');
  return Array.from(document.querySelectorAll('.clip'))
    .filter((el) => {
      const owner = el.closest('[data-composition-id]');
      return owner === null || owner === rootEl;
    })
    .map((el) => {
      const start = parseFloat(el.getAttribute('data-start') ?? '');
      const duration = parseFloat(el.getAttribute('data-duration') ?? '');
      return { id: el.id || '', start, end: start + duration };
    })
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
}

describe('POST /restructure/:id — V5-P0C frame-exact quantization', () => {
  it.each([
    ['uniform sub-frame grid', [
      { id: 'scene-1', durationFrames: 10 },
      { id: 'scene-2', durationFrames: 10 },
      { id: 'scene-3', durationFrames: 10 },
    ]],
    ['mixed durations', [
      { id: 'scene-1', durationFrames: 45 },
      { id: 'scene-2', durationFrames: 15 },
      { id: 'scene-3', durationFrames: 10 },
    ]],
    ['integer legacy case', [
      { id: 'scene-1', durationFrames: 90 },
      { id: 'scene-2', durationFrames: 150 },
    ]],
  ])('%s → exactly one clip visible at every frame tick (B2 invariant)', async (_, scenes) => {
    await stage('proj-p0c-1');
    const res = await post('/restructure/proj-p0c-1', { scenes, fps: 30 }, { 'X-Worker-Secret': SECRET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string; findings?: unknown[] };

    // The lint validates the SAME served HTML — must be clean by construction.
    expect(body.findings).toEqual([]);
    expect(lintClipWindows(body.html)).toEqual([]);

    const wins = extractWindows(body.html);
    expect(wins.length).toBe(scenes.length);

    // THE invariant: for every integer frame tick f of the timeline, the
    // runtime-style window test sees EXACTLY ONE clip.
    const totalFrames = scenes.reduce((s, sc) => s + sc.durationFrames, 0);
    for (let f = 0; f < totalFrames; f += 1) {
      const t = f / 30;
      const visible = wins.filter((w) => t >= w.start && t < w.end);
      if (visible.length !== 1) {
        throw new Error(
          `frame ${f} (t=${t}): ${visible.length} clips visible [${visible.map((v) => v.id).join(', ')}]`,
        );
      }
    }
    // Past the end: nothing visible.
    const afterEnd = totalFrames / 30 + 1;
    expect(wins.filter((w) => afterEnd >= w.start && afterEnd < w.end)).toHaveLength(0);
  });

  it('serializes starts as shortest round-trip doubles on the k/fps grid', async () => {
    await stage('proj-p0c-2');
    const res = await post(
      '/restructure/proj-p0c-2',
      { scenes: [{ id: 'scene-1', durationFrames: 10 }, { id: 'scene-2', durationFrames: 10 }] },
      { 'X-Worker-Secret': SECRET },
    );
    const body = (await res.json()) as { html: string };
    // Round-trip: parseFloat(start_i) === fl(k_i/fps) EXACTLY.
    const wins = extractWindows(body.html);
    expect(wins[0].start).toBe(0);
    expect(wins[1].start).toBe(10 / 30);
  });

  it('legacy integer expectations are unchanged ("3"/"5"/"8")', async () => {
    await stage('proj-restr-legacy');
    const res = await post(
      '/restructure/proj-restr-legacy',
      { scenes: [{ id: 'scene-3', durationFrames: 90 }, { id: 'scene-1', durationFrames: 150 }], fps: 30 },
      { 'X-Worker-Secret': SECRET },
    );
    const body = (await res.json()) as { html: string };
    expect(body.html).toMatch(/id="scene-3"[^>]*data-start="0"[^>]*data-duration="3"/s);
    expect(body.html).toMatch(/id="scene-1"[^>]*data-start="3"[^>]*data-duration="5"/s);
    expect(body.html).toMatch(/data-composition-id="main"[^>]*data-duration="8"/s);
  });

  it('is idempotent — restructuring twice converges byte-exactly', async () => {
    await stage('proj-p0c-idem');
    const scenes = { scenes: [{ id: 'scene-1', durationFrames: 10 }, { id: 'scene-2', durationFrames: 25 }], fps: 30 };
    const first = await post('/restructure/proj-p0c-idem', scenes, { 'X-Worker-Secret': SECRET });
    const a = ((await first.json()) as { html: string }).html;
    const second = await post('/restructure/proj-p0c-idem', scenes, { 'X-Worker-Secret': SECRET });
    const b = ((await second.json()) as { html: string }).html;
    expect(b).toBe(a);
  });

  it('normalization at staging repairs authored overlaps/gaps onto the grid', async () => {
    const BAD_HTML = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="20">
  <div id="scene-1" class="clip" data-start="0" data-duration="6"></div>
  <div id="scene-2" class="clip" data-start="5.9" data-duration="6"></div>
  <div id="scene-3" class="clip" data-start="13.5" data-duration="6"></div>
</div>
</body></html>`;
    const stageRes = await fetch(`${base}/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: 'job-p0c-stage', project_id: 'proj-p0c-stage', mode: 'preview', index_html: BAD_HTML }),
    });
    expect(stageRes.status).toBe(200);

    const preview = await fetch(`${base}/preview/proj-p0c-stage`);
    const html = await preview.text();
    // Contiguous integer-second grid: overlap/gap eliminated.
    const wins = extractWindows(html);
    expect(wins.map((w) => w.start)).toEqual([0, 6, 12]);
    expect(lintClipWindows(html)).toEqual([]);

    // Unit-level: the normalizer reports what it changed.
    const norm = normalizeClipWindows(BAD_HTML, 30);
    expect(norm.adjusted.map((a) => a.id)).toEqual(['scene-2', 'scene-3']);
    expect(norm.adjusted[0].from.start).toBe('5.9');
    expect(norm.adjusted[0].to.start).toBe('6');
    // Idempotent on clean input.
    const twice = normalizeClipWindows(norm.html, 30);
    expect(twice.adjusted).toEqual([]);
    expect(twice.html).toBe(norm.html);
  });

  it('normalization skips clips without usable durations and nested timelines', () => {
    const HTML = `<!doctype html><html><body>
<div class="composition" data-composition-id="main" data-duration="9">
  <div id="keep-me" class="clip" data-start="0"></div>
  <div id="nested" class="clip" data-composition-id="nested" data-start="0" data-duration="99">
    <div id="inner" class="clip" data-start="77" data-duration="3"></div>
  </div>
  <div id="scene-a" class="clip" data-start="0" data-duration="2.9999"></div>
  <div id="scene-b" class="clip" data-start="3.5" data-duration="3"></div>
</div>
</body></html>`;
    const norm = normalizeClipWindows(HTML, 30);
    expect(norm.adjusted.map((a) => a.id)).toEqual(['scene-a', 'scene-b']);
    expect(norm.adjusted[1].from.start).toBe('3.5');
    expect(norm.adjusted[1].to.start).toBe('3');
    expect(norm.html).toMatch(/id="inner"[^>]*data-start="77"/s); // untouched
    expect(extractWindows(norm.html).map((w) => w.start)).toEqual([0, 3]);
  });
});
