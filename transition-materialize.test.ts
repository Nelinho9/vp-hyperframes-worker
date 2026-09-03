// @vitest-environment node
/**
 * transition-materialize.test.ts — V5-P2C (§7.2): transições entre cenas.
 *
 * Cobre:
 * 1. Tabela canónica TRANSITION_TWEENS (paridade byte-a-byte com o espelho
 *    do app) + fonte aplicadora (`TRANSITION_APPLY_SOURCE`) executada em
 *    sandbox vm com linkedom + gsap mockado.
 * 2. collectTransitionSpecs / upsertTransitionBlock (bloco único estático,
 *    idempotente, removível).
 * 3. POST /restructure/:id com `transitions[]`: janela do clip saínte
 *    EXTENDIDA frame-exato (end = k_{i+1} + o_i/fps), entrante intacto,
 *    duração ROOT inalterada, atributos data-transition-out/in escritos,
 *    lint limpo e invariante por tick ("1 clip; 2 apenas dentro do overlap").
 * 4. Payload inválido ignorado; clamps de duração; cenas curtas clampeadas.
 * 5. Idempotência byte-exata; remoção converge para o apply limpo.
 * 6. normalizeClipWindows preserva os overlaps declarados (round-trip).
 *
 * Doc: docs/video-engine/V5_P2C_TRANSICOES.md §2
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { app } from './server.js';
import { normalizeClipWindows, exactWindowDuration } from './patch-engine.js';
import { lintClipWindows } from './window-lint.js';
import {
  TRANSITION_TWEENS,
  TRANSITIONS_CANONICAL_JSON,
  TRANSITION_APPLY_SOURCE,
  TRANSITION_APPLY_FN_NAME,
  TRANSITION_BLOCK_ID,
  parseTransitionAttr,
  collectTransitionSpecs,
  upsertTransitionBlock,
} from './transition-presets.js';

/** String canónica — hardcode idêntico ao teste do app (paridade CI). */
const EXPECTED_CANONICAL =
  '{"fade":{"out":{"to":{"opacity":0},"ease":"power1.inOut"},"in":{"from":{"opacity":0},"to":{"opacity":1},"ease":"power1.inOut"}},"dissolve":{"out":{"to":{"opacity":0},"ease":"none"},"in":{"from":{"opacity":0},"to":{"opacity":1},"ease":"none"}},"wipeLeft":{"in":{"from":{"clipPath":"inset(0 100% 0 0)"},"to":{"clipPath":"inset(0 0% 0 0)"},"ease":"power2.inOut"}},"wipeRight":{"in":{"from":{"clipPath":"inset(0 0% 0 100%)"},"to":{"clipPath":"inset(0 0% 0 0%)"},"ease":"power2.inOut"}},"slide":{"in":{"from":{"xPercent":100},"to":{"xPercent":0},"ease":"power2.inOut"}},"zoomBlur":{"out":{"to":{"opacity":0,"scale":0.94},"ease":"power1.in"},"in":{"from":{"opacity":0,"scale":1.08,"filter":"blur(8px)"},"to":{"opacity":1,"scale":1,"filter":"blur(0px)"},"ease":"power1.out"}}}';

describe('TRANSITION_TWEENS — tabela canónica (V5-P2C)', () => {
  it('serialização idêntica nos DOIS repos', () => {
    expect(TRANSITIONS_CANONICAL_JSON).toBe(EXPECTED_CANONICAL);
  });

  it('kinds na ordem do contrato; props só opacity/transform/clipPath/filter', () => {
    expect(Object.keys(TRANSITION_TWEENS)).toEqual([
      'fade', 'dissolve', 'wipeLeft', 'wipeRight', 'slide', 'zoomBlur',
    ]);
    for (const preset of Object.values(TRANSITION_TWEENS)) {
      for (const side of ['in', 'out'] as const) {
        const half = preset[side];
        if (!half) continue;
        const keys = [...Object.keys(half.from ?? {}), ...Object.keys(half.to)];
        for (const k of keys) {
          expect(['opacity', 'scale', 'xPercent', 'clipPath', 'filter']).toContain(k);
        }
        expect(typeof half.ease).toBe('string');
      }
    }
    // wipe/slide não têm lado out (o saínte fica parado por baixo).
    expect(TRANSITION_TWEENS.wipeLeft.out).toBeUndefined();
    expect(TRANSITION_TWEENS.slide.out).toBeUndefined();
  });

  it('fonte aplicadora embute a tabela e os marcadores de contrato', () => {
    expect(TRANSITION_APPLY_SOURCE.startsWith(`function ${TRANSITION_APPLY_FN_NAME}`)).toBe(true);
    expect(TRANSITION_APPLY_SOURCE).toContain('[data-transition-in]');
    expect(TRANSITION_APPLY_SOURCE).toContain('__vpTransitionsApplied');
    expect(TRANSITION_APPLY_SOURCE).toContain("'data-start'");
    expect(TRANSITION_APPLY_SOURCE).toContain('clipPath');
    expect(() => new vm.Script(TRANSITION_APPLY_SOURCE)).not.toThrow();
  });
});

// ─── Execução da fonte aplicadora em sandbox ────────────────────────────────

interface MockTween {
  vars: Record<string, unknown>;
  targets: () => unknown[];
  killed: boolean;
  kill(): void;
}

interface MockTimeline {
  calls: Array<{ m: string; target: unknown; from?: unknown; to?: unknown; pos?: number }>;
  children: MockTween[];
  times: number[];
  paused?: boolean;
  time(v?: number): number;
}

function makeMockGsap() {
  const timelines: MockTimeline[] = [];
  const gsap = {
    timeline(cfg: { paused?: boolean }) {
      const tl = {} as MockTimeline;
      tl.calls = [];
      tl.children = [];
      tl.times = [];
      tl.paused = cfg?.paused;
      let cur = 0;
      tl.time = (v?: number) => {
        if (v !== undefined) {
          cur = v;
          tl.times.push(v);
        }
        return cur;
      };
      const track = (vars: Record<string, unknown>, target: unknown): MockTween => {
        const tw: MockTween = { vars, targets: () => [target], killed: false };
        tw.kill = () => { tw.killed = true; };
        return tw;
      };
      (tl as unknown as {
        fromTo: (t: unknown, f: unknown, to: Record<string, unknown>, p: number) => MockTween;
      }).fromTo = (target, from, to, pos) => {
        tl.calls.push({ m: 'fromTo', target, from, to, pos });
        const tw = track({ ...to, startAt: { ...(from as object) } }, target);
        tl.children.push(tw);
        return tw;
      };
      (tl as unknown as {
        to: (t: unknown, to: Record<string, unknown>, p: number) => MockTween;
      }).to = (target, to, pos) => {
        tl.calls.push({ m: 'to', target, to, pos });
        const tw = track({ ...to }, target);
        tl.children.push(tw);
        return tw;
      };
      timelines.push(tl);
      return tl as unknown as Record<string, unknown>;
    },
  };
  return { gsap, timelines };
}

const APPLY_FIXTURE = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div id="main" data-composition-id="main" data-duration="9">
  <div id="sc1" class="clip" data-start="0" data-duration="3" data-transition-out="fade@400"></div>
  <div id="sc2" class="clip" data-start="3" data-duration="3" data-transition-in="fade@400" data-transition-out="dissolve@600"></div>
  <div id="sc3" class="clip" data-start="6" data-duration="3" data-transition-in="zoomBlur@800" data-transition-out="starWipe@999"></div>
</div>
</body>
</html>`;

describe('__vpApplyTransitions — execução (sandbox vm + gsap mock)', () => {
  function boot(html: string) {
    const { document } = parseHTML(html);
    const mock = makeMockGsap();
    const w: Record<string, unknown> = { __timelines: {} };
    const sandbox = { window: w, document, gsap: mock.gsap, isFinite, parseFloat };
    vm.createContext(sandbox);
    vm.runInContext(TRANSITION_APPLY_SOURCE, sandbox, { filename: 'vp-transitions-apply.js' });
    return { mock, w, sandbox };
  }

  it('posiciona in no início da janela e out no fim−duração; ignora kinds inválidos', () => {
    const { mock, w, sandbox } = boot(APPLY_FIXTURE);
    const applied = vm.runInContext(
      `${TRANSITION_APPLY_FN_NAME}()`,
      sandbox,
      { filename: 'run.js' },
    ) as unknown[];
    expect(applied.length).toBe(4);
    const tl = mock.timelines[0];
    const byTargetId = (id: string) =>
      tl.calls.filter((c) => (c.target as { id?: string })?.id === id);

    // fade OUT em #sc1 (janela [0,3)): pos = 3 − 0.4.
    const out1 = byTargetId('sc1')[0];
    expect(out1.m).toBe('to');
    expect(out1.pos).toBeCloseTo(2.6, 5);
    expect(out1.to).toMatchObject({ opacity: 0, duration: 0.4, ease: 'power1.inOut' });

    // fade IN em #sc2: pos = 3 (início da janela).
    const in2 = byTargetId('sc2')[0];
    expect(in2.m).toBe('fromTo');
    expect(in2.pos).toBe(3);
    expect(in2.from).toEqual({ opacity: 0 });
    expect(in2.to).toMatchObject({ opacity: 1, duration: 0.4, ease: 'power1.inOut' });

    // dissolve OUT em #sc2: pos = 3 + 3 − 0.6.
    const out2 = byTargetId('sc2')[1];
    expect(out2.m).toBe('to');
    expect(out2.pos).toBeCloseTo(5.4, 5);
    expect(out2.to).toMatchObject({ opacity: 0, duration: 0.6, ease: 'none' });

    // zoomBlur IN em #sc3 (opacity+scale+filter).
    const in3 = byTargetId('sc3')[0];
    expect(in3.m).toBe('fromTo');
    expect(in3.pos).toBe(6);
    expect(in3.from).toEqual({ opacity: 0, scale: 1.08, filter: 'blur(8px)' });
    expect(in3.to).toMatchObject({ opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.8 });

    // starWipe (desconhecido) → nenhum tween adicional em #sc3.
    expect(byTargetId('sc3')).toHaveLength(1);

    expect(mock.timelines[0].paused).toBe(true);
    expect((w.__vpTransitionsApplied as unknown[]).length).toBe(4);
  });  it('re-execução mata os PRÓPRIOS tweens anteriores (nunca estrangeiros)', () => {
    const { mock, w, sandbox } = boot(APPLY_FIXTURE);
    vm.runInContext(`${TRANSITION_APPLY_FN_NAME}()`, sandbox, { filename: 'r1.js' });
    const aliveAfterFirst = mock.timelines[0].children.filter((c) => !c.killed);
    expect(aliveAfterFirst.length).toBe(4);

    vm.runInContext(`${TRANSITION_APPLY_FN_NAME}()`, sandbox, { filename: 'r2.js' });
    const alive = mock.timelines[0].children.filter((c) => !c.killed);
    expect(alive.length).toBe(4);
    for (const t of alive) expect(aliveAfterFirst).not.toContain(t);
    void w;
  });

  it('sem gsap global: no-op silencioso', () => {
    const { document } = parseHTML(`<div id="m" data-composition-id="m"><i id="sc1" data-transition-in="fade@200"></i></div>`);
    const w: Record<string, unknown> = { __timelines: {} };
    const sandbox = { window: w, document, isFinite, parseFloat };
    vm.createContext(sandbox);
    vm.runInContext(TRANSITION_APPLY_SOURCE, sandbox, { filename: 'apply.js' });
    const res = vm.runInContext(`${TRANSITION_APPLY_FN_NAME}()`, sandbox, { filename: 'run.js' });
    expect(res).toEqual([]);
  });
});

// ─── collectTransitionSpecs / upsertTransitionBlock ─────────────────────────

describe('collectTransitionSpecs — coleta determinística do DOM', () => {
  it('deriva specs com chaves em ordem fixa; ignora kinds inválidos/sem id/malformados', () => {
    const html = `<div id="main" data-composition-id="main">
      <b id="sc-a" data-transition-in="fade@400" data-transition-out="dissolve@600"></b>
      <b id="sc-b" data-transition-in="starWipe@400"></b>
      <b id="sc-c" data-transition-in="fade"></b>
      <b data-transition-in="fade@400"></b>
      <b id="sc-e" data-transition-out="slide@250"></b>
      <b id="sc-f" data-transition-out="fade@250"></b>
    </div>`;
    const { document } = parseHTML(html);
    expect(collectTransitionSpecs(document)).toEqual([
      { sel: '#sc-a', in: 'fade', inMs: 400, out: 'dissolve', outMs: 600 },
      // slide não tem lado OUT na tabela → ignorado.
      { sel: '#sc-f', out: 'fade', outMs: 250 },
    ]);
  });

  it('lista vazia quando nada tem transição', () => {
    const { document } = parseHTML(`<div><b id="a"></b></div>`);
    expect(collectTransitionSpecs(document)).toEqual([]);
  });
});

describe('upsertTransitionBlock — bloco único, estático, idempotente, removível', () => {
  const SPECS = [{ sel: '#sc-a', in: 'fade', inMs: 400 }];
  const HTML = `<html><body><div id="sc-a"></div></body></html>`;

  it('insere UM bloco (conteúdo ESTÁTICO) antes de </body>', () => {
    const out = upsertTransitionBlock(HTML, SPECS);
    expect(out.match(new RegExp(`id="${TRANSITION_BLOCK_ID}"`, 'g'))?.length).toBe(1);
    expect(out.indexOf(TRANSITION_BLOCK_ID)).toBeLessThan(out.search(/<\/body>/i));
    expect(out).toContain(`${TRANSITION_APPLY_FN_NAME}()`);
    expect(out).not.toContain('__vpTransitionSpecs');
  });

  it('re-aplicação converge byte-exato e substitui (nunca duplica)', () => {
    const once = upsertTransitionBlock(HTML, SPECS);
    const twice = upsertTransitionBlock(once, SPECS);
    expect(twice).toBe(once);
  });

  it('zero specs remove o bloco existente (HTML limpo)', () => {
    const cleaned = upsertTransitionBlock(upsertTransitionBlock(HTML, SPECS), []);
    expect(cleaned).not.toContain(TRANSITION_BLOCK_ID);
    expect(upsertTransitionBlock(cleaned, [])).toBe(cleaned);
  });
});

describe('parseTransitionAttr — formato "kind@ms"', () => {
  it('válidos devolvem {kind, durationMs}; malformados/inválidos → null', () => {
    expect(parseTransitionAttr('fade@400')).toEqual({ kind: 'fade', durationMs: 400 });
    expect(parseTransitionAttr('zoomBlur@800')).toEqual({ kind: 'zoomBlur', durationMs: 800 });
    // Clamp canónico [200, 800].
    expect(parseTransitionAttr('fade@50')?.durationMs).toBe(200);
    expect(parseTransitionAttr('fade@5000')?.durationMs).toBe(800);
    expect(parseTransitionAttr('starWipe@400')).toBeNull();
    expect(parseTransitionAttr('fade')).toBeNull();
    expect(parseTransitionAttr('fade@')).toBeNull();
    expect(parseTransitionAttr('@400')).toBeNull();
    expect(parseTransitionAttr(null)).toBeNull();
  });
});

// ─── POST /restructure/:id com transitions ──────────────────────────────────

const COMPOSITION_HTML = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="12" data-width="1080" data-height="1920">
  <h1 id="text-headline-1" style="color: #ffffff;">Hello</h1>
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

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function extractWindows(html: string): Array<{
  id: string;
  start: number;
  end: number;
  attrs: { in: string | null; out: string | null };
}> {
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
      return {
        id: el.id || '',
        start,
        end: start + duration,
        attrs: {
          in: el.getAttribute('data-transition-in'),
          out: el.getAttribute('data-transition-out'),
        },
      };
    })
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
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

describe('POST /restructure/:id — V5-P2C materialização de transições', () => {
  const SCENES = [
    { id: 'scene-1', durationFrames: 90 },
    { id: 'scene-2', durationFrames: 90 },
    { id: 'scene-3', durationFrames: 90 },
  ];
  const TRANSITIONS = [{ id: 'scene-2', kind: 'fade', durationMs: 400 }];

  it('janela saínte estendida frame-exato; entrante e ROOT intactos; attrs escritos', async () => {
    await stage('proj-p2c-1');
    const res = await post(
      '/restructure/proj-p2c-1',
      { scenes: SCENES, transitions: TRANSITIONS, fps: 30 },
      { 'X-Worker-Secret': SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string; findings: unknown[] };

    // Overlap permitido pelo lint — zero findings.
    expect(body.findings).toEqual([]);
    expect(lintClipWindows(body.html)).toEqual([]);

    const wins = extractWindows(body.html);
    expect(wins.map((w) => w.id)).toEqual(['scene-1', 'scene-2', 'scene-3']);
    // scene-1: [0, (90+12)/30 = 3.4) — extendido exatamente o overlap.
    expect(wins[0].start).toBe(0);
    expect(wins[0].end).toBeCloseTo(102 / 30, 12);
    // scene-2 começa INTACTO na fronteira k=3.
    expect(wins[1].start).toBe(90 / 30);
    expect(wins[2].start).toBe(180 / 30);
    // Root NÃO muda (o overlap vive dentro da duração total).
    const { document } = parseHTML(body.html);
    expect(document.querySelector('[data-composition-id]')?.getAttribute('data-duration')).toBe('9');

    // Atributos auto-descritivos nas DUAS pontas.
    expect(wins[0].attrs.out).toBe('fade@400');
    expect(wins[1].attrs.in).toBe('fade@400');
    expect(wins[1].attrs.out).toBeNull();
    expect(wins[2].attrs.in).toBeNull();

    // Bloco materializado presente.
    expect(body.html).toContain(`id="${TRANSITION_BLOCK_ID}"`);
    expect(body.html).toContain('__vpApplyTransitions()');
  });

  it('invariante por tick: 1 clip visível fora do overlap, 2 dentro dele', async () => {
    await stage('proj-p2c-ticks');
    const res = await post(
      '/restructure/proj-p2c-ticks',
      { scenes: SCENES, transitions: TRANSITIONS, fps: 30 },
      { 'X-Worker-Secret': SECRET },
    );
    const body = (await res.json()) as { html: string };
    const wins = extractWindows(body.html);
    const totalFrames = 270;
    for (let f = 0; f < totalFrames; f += 1) {
      const t = f / 30;
      const visible = wins.filter((w) => t >= w.start && t < w.end);
      const inOverlap = f >= 90 && f < 102;
      const expected = inOverlap ? 2 : 1;
      if (visible.length !== expected) {
        throw new Error(
          `frame ${f} (t=${t}): ${visible.length} visíveis (esperado ${expected}) [${visible.map((v) => v.id).join(', ')}]`,
        );
      }
      if (inOverlap) {
        expect(visible.map((v) => v.id).sort()).toEqual(['scene-1', 'scene-2']);
      }
    }
    // Passado o fim: nada visível.
    const afterEnd = totalFrames / 30 + 1;
    expect(wins.filter((w) => afterEnd >= w.start && afterEnd < w.end)).toHaveLength(0);
  });

  it('payload semanticamente inválido é ignorado; duração é clampeada [200,800]', async () => {
    await stage('proj-p2c-invalid');
    const res = await post(
      '/restructure/proj-p2c-invalid',
      {
        scenes: SCENES,
        transitions: [
          { id: 'scene-x', kind: 'fade', durationMs: 400 }, // id ausente na composição
          { id: 'scene-3', kind: 'starWipe', durationMs: 400 }, // kind desconhecido
          { id: 'scene-3', kind: 'dissolve', durationMs: 50 }, // clamp → 200
          { id: 'scene-2', kind: 'fade', durationMs: 5000 }, // clamp → 800
        ],
        fps: 30,
      },
      { 'X-Worker-Secret': SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string };
    const wins = extractWindows(body.html);
    // scene-2 ← fade@800: overlap 24f → end de scene-1 = (90+24)/30 = 3.8.
    expect(wins[0].end).toBeCloseTo(114 / 30, 12);
    expect(wins[0].attrs.out).toBe('fade@800');
    expect(wins[1].attrs.in).toBe('fade@800');
    // scene-3 ← dissolve@200: overlap 6f → end de scene-2 = (180+6)/30 = 6.2.
    expect(wins[1].end).toBeCloseTo(186 / 30, 12);
    expect(wins[1].attrs.out).toBe('dissolve@200');
    expect(wins[2].attrs.in).toBe('dissolve@200');
    expect(lintClipWindows(body.html)).toEqual([]);
  });

  it('payload com shape inválido → 400 (validação da rota)', async () => {
    await stage('proj-p2c-shape');
    for (const transitions of [
      'not-an-array',
      [{ id: 'scene-2' }],
      [{ id: 'scene-2', kind: 'fade' }],
      [{ id: 'scene-2', kind: 'fade', durationMs: 'abc' }],
    ]) {
      const res = await post(
        '/restructure/proj-p2c-shape',
        { scenes: SCENES, transitions, fps: 30 },
        { 'X-Worker-Secret': SECRET },
      );
      expect(res.status).toBe(400);
    }
  });

  it('cenas curtas clampeiam o overlap às frames disponíveis', async () => {
    await stage('proj-p2c-short');
    const res = await post(
      '/restructure/proj-p2c-short',
      {
        scenes: [
          { id: 'scene-1', durationFrames: 15 },
          { id: 'scene-2', durationFrames: 15 },
        ],
        transitions: [{ id: 'scene-2', kind: 'fade', durationMs: 800 }],
        fps: 30,
      },
      { 'X-Worker-Secret': SECRET },
    );
    const body = (await res.json()) as { html: string };
    const wins = extractWindows(body.html);
    // o = min(24, 15, 15) = 15 → end de scene-1 = (15+15)/30 = 1.0.
    expect(wins[0].end).toBeCloseTo(1, 12);
    expect(wins[1].start).toBe(0.5);
    expect(wins[0].attrs.out).toBe('fade@500');
    expect(wins[1].attrs.in).toBe('fade@500');
    expect(lintClipWindows(body.html)).toEqual([]);

    const norm = normalizeClipWindows(body.html, 30);
    expect(norm.warning).toBeNull();
    expect(norm.adjusted).toEqual([]);
    expect(norm.html).toBe(body.html);
  });

  it('idempotência: mesma carga → HTML byte-idêntico', async () => {
    await stage('proj-p2c-idem');
    const payload = { scenes: SCENES, transitions: TRANSITIONS, fps: 30 };
    const first = await post('/restructure/proj-p2c-idem', payload, { 'X-Worker-Secret': SECRET });
    const a = ((await first.json()) as { html: string }).html;
    const second = await post('/restructure/proj-p2c-idem', payload, { 'X-Worker-Secret': SECRET });
    const b = ((await second.json()) as { html: string }).html;
    expect(b).toBe(a);
  });

  it('remover a transição converge byte-exato para o apply limpo', async () => {
    await stage('proj-p2c-remove');
    const withT = await post(
      '/restructure/proj-p2c-remove',
      { scenes: SCENES, transitions: TRANSITIONS, fps: 30 },
      { 'X-Worker-Secret': SECRET },
    );
    expect(((await withT.json()) as { html: string }).html).toContain(TRANSITION_BLOCK_ID);

    await stage('proj-p2c-clean');
    const cleanRes = await post(
      '/restructure/proj-p2c-clean',
      { scenes: SCENES, fps: 30 },
      { 'X-Worker-Secret': SECRET },
    );
    const cleanHtml = ((await cleanRes.json()) as { html: string }).html;

    const removedRes = await post(
      '/restructure/proj-p2c-remove',
      { scenes: SCENES, transitions: [], fps: 30 },
      { 'X-Worker-Secret': SECRET },
    );
    const removedHtml = ((await removedRes.json()) as { html: string }).html;
    expect(removedHtml).not.toContain(TRANSITION_BLOCK_ID);
    expect(removedHtml).not.toContain('data-transition-in');
    expect(removedHtml).not.toContain('data-transition-out');
    expect(removedHtml).toBe(cleanHtml);
  });

  it('normalizeClipWindows preserva os overlaps declarados (round-trip)', async () => {
    await stage('proj-p2c-norm');
    const res = await post(
      '/restructure/proj-p2c-norm',
      { scenes: SCENES, transitions: TRANSITIONS, fps: 30 },
      { 'X-Worker-Secret': SECRET },
    );
    const restructured = ((await res.json()) as { html: string }).html;

    const norm = normalizeClipWindows(restructured, 30);
    expect(norm.adjusted).toEqual([]);
    expect(norm.html).toBe(restructured);

    // E o HTML normalizado continua lint-limpo.
    expect(lintClipWindows(norm.html)).toEqual([]);
  });

  it('exactWindowDuration continua a base da extensão (sanity)', () => {
    // A janela extendida nunca excede a fronteira dupla seguinte.
    const d = exactWindowDuration(0, 102 / 30);
    expect(0 + d).toBeLessThanOrEqual(102 / 30);
  });
});
