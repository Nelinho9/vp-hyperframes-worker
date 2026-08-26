// @vitest-environment node
/**
 * replace-scene-html.test.ts — V5-P4B (S19 §2.1): `/restructure` aceita
 * `replace_scene_html {id, html}` e substitui o INNERHTML da cena alvo.
 *
 * Invariantes:
 * - Janela/timeline intactos por construção (data-start/duration/track-index
 *   do clip alvo e das restantes cenas ficam exatamente como estavam).
 * - Estrutura é da timeline: fragmento com <script>, .clip ou
 *   [data-composition-id] → 400; cena ausente → 404.
 * - Registry coerente (deriveElements do HTML final) e bloco de animação
 *   materializado reflete os data-anim-* novos do fragmento.
 * - Idempotência byte-exata e invariante B2 pós-replace.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { parseHTML } from 'linkedom';
import { app } from './server.js';
import { TRANSITION_BLOCK_ID } from './transition-presets.js';

const SECRET = 'test-worker-secret';

const COMPOSITION_HTML = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="12" data-width="1080" data-height="1920">
  <h1 id="text-headline-1" style="color:#fff">Hello</h1>
  <div id="scene-1" class="clip" data-start="0" data-duration="6" data-track-index="0"><p id="scene-1-text-1">One</p></div>
  <div id="scene-2" class="clip" data-start="6" data-duration="6" data-track-index="0"><p id="scene-2-text-9">Old copy</p></div>
  <div id="scene-3" class="clip" data-start="12" data-duration="6" data-track-index="0"></div>
</div>
</body>
</html>`;

let server: http.Server;
let base: string;

const workerApp = app as unknown as {
  listen: (port: number, host: string) => http.Server;
};

async function stage(projectId: string, html: string = COMPOSITION_HTML) {
  const res = await fetch(`${base}/job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: `job-${projectId}`,
      project_id: projectId,
      mode: 'preview',
      index_html: html,
    }),
  });
  expect(res.status).toBe(200);
}

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': SECRET },
    body: JSON.stringify(body),
  });
}

/** Payload cumulativo estável: mesmas janelas do documento staged. */
const SCENES = [
  { id: 'scene-1', durationFrames: 180 },
  { id: 'scene-2', durationFrames: 180 },
  { id: 'scene-3', durationFrames: 180 },
];

const NEW_FRAGMENT =
  '<h2 id="scene-2-text-1" style="color:#fff;font-size:80px;margin:0;">Rewritten</h2>' +
  '<img id="scene-2-img-1" src="assets/new.jpg" style="position:absolute;width:400px;" />';

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

interface RestructureResponse {
  ok: boolean;
  applied: number;
  removed: string[];
  replaced?: string | null;
  html: string;
  findings: Array<{ code: string }>;
  elements?: { elements: Array<{ id?: string }> };
}

describe('POST /restructure/:id — V5-P4B replace_scene_html', () => {
  it('substitui o innerHTML da cena mantendo janelas, resto do doc e devolvendo registry novo', async () => {
    await stage('proj-rsh-1');
    const res = await post('/restructure/proj-rsh-1', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-2', html: NEW_FRAGMENT },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RestructureResponse;
    expect(body.ok).toBe(true);
    expect(body.replaced).toBe('scene-2');

    const { document } = parseHTML(body.html);
    const target = document.getElementById('scene-2');
    expect(target?.innerHTML).toContain('Rewritten');
    expect(target?.innerHTML).not.toContain('Old copy');
    // Janela/timeline do clip alvo intactas por construção…
    expect(target?.getAttribute('data-start')).toBe('6');
    expect(target?.getAttribute('data-duration')).toBe('6');
    expect(target?.getAttribute('data-track-index')).toBe('0');
    // …e o resto do documento também.
    expect(document.getElementById('scene-1')?.innerHTML).toContain('One');
    expect(document.getElementById('text-headline-1')?.textContent).toBe('Hello');
    expect(document.querySelector('[data-composition-id]')?.getAttribute('data-duration')).toBe('18');
    expect(body.findings).toEqual([]);

    // Registry derivado do HTML final: filhos novos entram, antigos saem.
    const ids = (body.elements?.elements ?? []).map((e) => e.id);
    expect(ids).toContain('scene-2-text-1');
    expect(ids).toContain('scene-2-img-1');
    expect(ids).not.toContain('scene-2-text-9');
  });

  it('preserva a transição declarada no clip substituído', async () => {
    await stage('proj-rsh-tr');
    const res = await post('/restructure/proj-rsh-tr', {
      scenes: SCENES,
      fps: 30,
      transitions: [{ id: 'scene-3', kind: 'fade', durationMs: 400 }],
      replace_scene_html: { id: 'scene-2', html: NEW_FRAGMENT },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RestructureResponse;
    const { document } = parseHTML(body.html);
    expect(document.getElementById('scene-2')?.getAttribute('data-transition-out')).toBe('fade@400');
    expect(document.getElementById('scene-3')?.getAttribute('data-transition-in')).toBe('fade@400');
    // Bloco de transições materializado presente (S13).
    expect(body.html.includes(String(TRANSITION_BLOCK_ID))).toBe(true);
  });

  it('materializa o bloco de animação quando o fragmento traz data-anim-*', async () => {
    await stage('proj-rsh-anim');
    const res = await post('/restructure/proj-rsh-anim', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: {
        id: 'scene-2',
        html: '<h2 id="scene-2-text-1" data-anim-in="riseIn" data-anim-dur-ms="500" style="color:#fff">Anim</h2>',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RestructureResponse;
    expect(body.html).toContain('__vp-anim-materialized__');
    expect(body.html).toContain('data-anim-in="riseIn"');
  });

  it('400 para fragmento com <script>', async () => {
    await stage('proj-rsh-scr');
    const res = await post('/restructure/proj-rsh-scr', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-2', html: '<b onclick="x()">ok</b><script>alert(1)</script>' },
    });
    expect(res.status).toBe(400);
  });

  it('400 para fragmento com .clip (estrutura é da timeline)', async () => {
    await stage('proj-rsh-clip');
    const res = await post('/restructure/proj-rsh-clip', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-2', html: '<div id="x" class="clip" data-start="0"></div>' },
    });
    expect(res.status).toBe(400);
  });

  it('400 para fragmento com raiz de composição aninhada', async () => {
    await stage('proj-rsh-root');
    const res = await post('/restructure/proj-rsh-root', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-2', html: '<div data-composition-id="nested"></div>' },
    });
    expect(res.status).toBe(400);
  });

  it('404 quando a cena alvo não existe na composição', async () => {
    await stage('proj-rsh-404');
    const res = await post('/restructure/proj-rsh-404', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-9', html: '<p id="scene-9-text-1">x</p>' },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('scene-9');
  });

  it('400 para shape inválido e para html acima do cap', async () => {
    await stage('proj-rsh-shape');
    const missingHtml = await post('/restructure/proj-rsh-shape', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-2' },
    });
    expect(missingHtml.status).toBe(400);

    const oversize = await post('/restructure/proj-rsh-shape', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-2', html: 'a'.repeat(200_001) },
    });
    expect(oversize.status).toBe(400);

    const badId = await post('/restructure/proj-rsh-shape', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 42, html: '<p>x</p>' },
    });
    expect(badId.status).toBe(400);
  });

  it('é idempotente — aplicar duas vezes converge byte-exato', async () => {
    await stage('proj-rsh-idem');
    const first = await post('/restructure/proj-rsh-idem', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-2', html: NEW_FRAGMENT },
    });
    const b1 = (await first.json()) as RestructureResponse;
    const second = await post('/restructure/proj-rsh-idem', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-2', html: NEW_FRAGMENT },
    });
    const b2 = (await second.json()) as RestructureResponse;
    expect(b2.html).toBe(b1.html);
  });

  it('invariante B2 pós-replace: exatamente uma cena visível em cada tick fora de overlap', async () => {
    await stage('proj-rsh-b2');
    const res = await post('/restructure/proj-rsh-b2', {
      scenes: SCENES,
      fps: 30,
      replace_scene_html: { id: 'scene-2', html: NEW_FRAGMENT },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RestructureResponse;
    const { document } = parseHTML(body.html);
    const root = document.querySelector('[data-composition-id]');
    const total = Math.round(parseFloat(root?.getAttribute('data-duration') ?? '0') * 30);
    const clips = Array.from(document.querySelectorAll('.clip')).map((el) => {
      const start = parseFloat(el.getAttribute('data-start') ?? '');
      const dur = parseFloat(el.getAttribute('data-duration') ?? '');
      return { start, end: start + dur, ovMs: parseFloat(el.getAttribute('data-transition-out') ?? '') || 0 };
    });
    expect(clips.length).toBe(3);
    const fps = 30;
    for (let f = 0; f < total; f += 1) {
      const t = f / fps;
      const visible = clips.filter((c) => t >= c.start && t < c.end);
      const inOverlap = clips.some((c) => c.ovMs > 0 && t >= c.end - c.ovMs / 1000 && t < c.end);
      if (inOverlap) continue; // dentro do overlap declarado podem ser 2
      expect(visible.length).toBe(1);
    }
  });
});
