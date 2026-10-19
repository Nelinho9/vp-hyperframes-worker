// @vitest-environment node
/**
 * f08-geometria-transicoes.test.ts -- F08.01 (baseline) + F08.10 (parte worker).
 *
 * Medicao/registo SEM modificar presets: geometria --el-* em tres formatos,
 * overlap de transicoes frame-exato, coexistencia preview/HTML dos blocos
 * materializados, registry v2 sem transitionIn/Out, audio x overlap sem
 * double-count, e a separacao de canais patch (props) vs restructure
 * (transicoes estruturais).
 *
 * Preservacao explicita: TRANSITION_TWEENS e duracoes intocados (canonico
 * byte-a-byte coberto por transition-materialize.test.ts), paridade PROP_MAP
 * (prop-map.test.ts), helper SEM applier de transicoes -- estrutural via
 * /restructure + reload do preview (previewReloadNonce no app), nunca hot-swap.
 */
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { PROP_MAP } from './prop-map.js';
import {
  applyPatchesLinkedom,
  applyTimelineRestructure,
  normalizeClipWindows,
} from './patch-engine.js';
import {
  TRANSITION_TWEENS,
  TRANSITION_DURATION_MIN_MS,
  TRANSITION_DURATION_MAX_MS,
  TRANSITION_BLOCK_ID,
  parseTransitionAttr,
} from './transition-presets.js';
import { ANIM_BLOCK_ID, collectAnimSpecs, upsertAnimBlock } from './anim-presets.js';
import { deriveElements, normalizeRegistry } from './elements-registry.js';
import { deriveAudioClips, replanVoiceWindows } from './audio-timeline.js';
import { lintClipWindows } from './window-lint.js';
import { PREVIEW_HELPER_SCRIPT } from './preview-helper.js';

function geomHtml(width: number, height: number) {
  return [
    '<!doctype html>',
    '<html><head><title>f08-geom</title></head>',
    '<body>',
    '<div data-composition-id="main" data-start="0" data-duration="6" data-width="' + width + '" data-height="' + height + '">',
    '  <h1 id="headline-1" data-anim-in="riseIn" style="position: absolute; left: 340px; top: 80px;">H</h1>',
    '  <img id="img-hero" src="assets/hero.jpg" style="width: 400px;" />',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

function scenesHtml(
  scenes: Array<{ id: string; start: number; duration: number }>,
  rootDur: string,
  inner = '',
) {
  const clips = scenes
    .map(
      (s) =>
        '<div id="' +
        s.id +
        '" class="clip" data-start="' +
        s.start +
        '" data-duration="' +
        s.duration +
        '" data-track-index="0">' +
        (s.id === 'scene-1' ? inner : '') +
        '</div>',
    )
    .join('\n  ');
  return [
    '<!doctype html>',
    '<html><head><title>f08</title></head>',
    '<body>',
    '<div class="composition" data-composition-id="main" data-start="0" data-duration="' +
      rootDur +
      '" data-width="1080" data-height="1920">',
    '  ' + clips,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

function extractWindows(html: string) {
  const { document } = parseHTML(html);
  const rootEl = document.querySelector('[data-composition-id]');
  return Array.from(document.querySelectorAll('.clip'))
    .filter((el) => {
      const owner = el.closest('[data-composition-id]');
      return owner === null || owner === rootEl;
    })
    .map((el) => ({
      id: el.id || '',
      start: parseFloat(el.getAttribute('data-start') ?? ''),
      duration: parseFloat(el.getAttribute('data-duration') ?? ''),
      out: el.getAttribute('data-transition-out'),
      inn: el.getAttribute('data-transition-in'),
    }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.duration))
    .map((w) => ({ ...w, end: w.start + w.duration }));
}

const SCENES_90 = [
  { id: 'scene-1', durationFrames: 90 },
  { id: 'scene-2', durationFrames: 90 },
  { id: 'scene-3', durationFrames: 90 },
];

const PRISTINE_9S = scenesHtml(
  [
    { id: 'scene-1', start: 0, duration: 3 },
    { id: 'scene-2', start: 3, duration: 3 },
    { id: 'scene-3', start: 6, duration: 3 },
  ],
  '9',
);

describe('F08.01 -- geometria --el-* em tres formatos (drag/resize baseline)', () => {
  const GEOM_PATCHES = [
    { selector: '#headline-1', property: 'x', value: '100' },
    { selector: '#headline-1', property: 'y', value: '60' },
    { selector: '#headline-1', property: 'rotation', value: '15' },
    { selector: '#img-hero', property: 'width', value: '420' },
    { selector: '#img-hero', property: 'height', value: '280' },
  ];

  it.each([
    ['landscape', 1920, 1080],
    ['portrait', 1080, 1920],
    ['square', 1080, 1080],
  ])('%s: x/y viram DELTA, width/height absolutos, rotation em deg -- nunca left/top', (_name, w, h) => {
    void _name;
    const { html, applied } = applyPatchesLinkedom(geomHtml(w, h), GEOM_PATCHES);
    expect(applied).toBe(5);
    expect(html).toMatch(/--el-x:\s*-240px/);
    expect(html).toMatch(/--el-y:\s*-20px/);
    expect(html).toMatch(/--el-rotate:\s*15deg/);
    expect(html).toMatch(/--el-w:\s*420px/);
    expect(html).toMatch(/--el-h:\s*280px/);
    expect(html).toMatch(/margin-left:\s*calc\(var\(--el-margin-x, 0px\) \+ var\(--el-x, 0px\)\)/);
    expect(html).toContain('rotate: var(--el-rotate, 0deg)');
    expect(html).toContain('width: var(--el-w)');
    expect(html).toContain('height: var(--el-h)');
    expect(html.match(/(?:^|[;"'])\s*left\s*:/g)?.length).toBe(1);
    expect(html).toMatch(/(?:^|[;"'])\s*left:\s*340px/);
    expect(html).toContain('data-width="' + w + '"');
    expect(html).toContain('data-height="' + h + '"');
    expect(html.match(/(?:^|[;"'])\s*top\s*:/g)?.length).toBe(1);
    expect(html).toContain('data-anim-in="riseIn"');
  });

  it('re-patch converge byte-exato (idempotente -- base do cancel/commit unico)', () => {
    const patches = [
      { selector: '#headline-1', property: 'x', value: '100' },
      { selector: '#headline-1', property: 'y', value: '60' },
    ];
    const once = applyPatchesLinkedom(geomHtml(1080, 1920), patches);
    const twice = applyPatchesLinkedom(once.html, patches);
    expect(twice.html).toBe(once.html);
  });
});

describe('F08.01 -- presets de transicao intactos (sem motor paralelo)', () => {
  it('seis kinds na ordem do contrato; wipe/slide sem lado out', () => {
    expect(Object.keys(TRANSITION_TWEENS)).toEqual([
      'fade', 'dissolve', 'wipeLeft', 'wipeRight', 'slide', 'zoomBlur',
    ]);
    expect(TRANSITION_TWEENS.wipeLeft.out).toBeUndefined();
    expect(TRANSITION_TWEENS.wipeRight.out).toBeUndefined();
    expect(TRANSITION_TWEENS.slide.out).toBeUndefined();
  });

  it('so opacity/transform/clipPath/filter; clamp canonico [200, 800]', () => {
    expect(TRANSITION_DURATION_MIN_MS).toBe(200);
    expect(TRANSITION_DURATION_MAX_MS).toBe(800);
    const ALLOWED = ['opacity', 'scale', 'xPercent', 'clipPath', 'filter'];
    for (const preset of Object.values(TRANSITION_TWEENS)) {
      for (const side of ['in', 'out'] as const) {
        const half = preset[side] as { from?: Record<string, unknown>; to: Record<string, unknown> } | undefined;
        if (!half) continue;
        for (const k of [...Object.keys(half.from ?? {}), ...Object.keys(half.to)]) {
          expect(ALLOWED).toContain(k);
        }
      }
    }
    expect(parseTransitionAttr('fade@400')).toEqual({ kind: 'fade', durationMs: 400 });
    expect(parseTransitionAttr('fade@50')?.durationMs).toBe(200);
    expect(parseTransitionAttr('fade@5000')?.durationMs).toBe(800);
    expect(parseTransitionAttr('starWipe@400')).toBeNull();
  });
});describe('F08.10 -- overlap frame-exato, cenas curtas, primeira/ultima cena', () => {
  it('fade@400: sainte estendida 12f, entrante intacto, ROOT inalterada, lint limpo', () => {
    const r = applyTimelineRestructure(PRISTINE_9S, SCENES_90, 30, [
      { id: 'scene-2', kind: 'fade', durationMs: 400 },
    ]);
    expect(lintClipWindows(r.html)).toEqual([]);
    const wins = extractWindows(r.html);
    expect(wins.map((w) => w.id)).toEqual(['scene-1', 'scene-2', 'scene-3']);
    expect(wins[0].start).toBe(0);
    expect(wins[0].end).toBeCloseTo(102 / 30, 12);
    expect(wins[1].start).toBe(90 / 30);
    expect(wins[0].out).toBe('fade@400');
    expect(wins[1].inn).toBe('fade@400');
    expect(wins[1].out).toBeNull();
    expect(wins[2].inn).toBeNull();
    const { document } = parseHTML(r.html);
    expect(document.querySelector('[data-composition-id]')?.getAttribute('data-duration')).toBe('9');
    expect(r.html).toContain('id="' + TRANSITION_BLOCK_ID + '"');
  });

  it('cenas curtas (15f): fade@800 clampeia para fade@500 sem frames pretos', () => {
    const base = scenesHtml(
      [
        { id: 'scene-1', start: 0, duration: 0.5 },
        { id: 'scene-2', start: 0.5, duration: 0.5 },
      ],
      '1',
    );
    const r = applyTimelineRestructure(
      base,
      [
        { id: 'scene-1', durationFrames: 15 },
        { id: 'scene-2', durationFrames: 15 },
      ],
      30,
      [{ id: 'scene-2', kind: 'fade', durationMs: 800 }],
    );
    const wins = extractWindows(r.html);
    expect(wins[0].end).toBeCloseTo(1, 12);
    expect(wins[1].start).toBe(0.5);
    expect(wins[0].out).toBe('fade@500');
    expect(wins[1].inn).toBe('fade@500');
    expect(lintClipWindows(r.html)).toEqual([]);
  });

  it('transicao na PRIMEIRA cena e ignorada (sem parceiro sainte) -- lint limpo', () => {
    const r = applyTimelineRestructure(PRISTINE_9S, SCENES_90, 30, [
      { id: 'scene-1', kind: 'fade', durationMs: 400 },
    ]);
    const wins = extractWindows(r.html);
    expect(wins.every((w) => w.out === null && w.inn === null)).toBe(true);
    expect(r.html).not.toContain(TRANSITION_BLOCK_ID);
    expect(lintClipWindows(r.html)).toEqual([]);
  });

  it('remocao converge byte-exato para o apply limpo; re-aplicacao idempotente', () => {
    const withT = applyTimelineRestructure(PRISTINE_9S, [...SCENES_90], 30, [
      { id: 'scene-2', kind: 'fade', durationMs: 400 },
    ]);
    const again = applyTimelineRestructure(PRISTINE_9S, [...SCENES_90], 30, [
      { id: 'scene-2', kind: 'fade', durationMs: 400 },
    ]);
    expect(again.html).toBe(withT.html);
    const removed = applyTimelineRestructure(withT.html, [...SCENES_90], 30, []);
    const clean = applyTimelineRestructure(PRISTINE_9S, [...SCENES_90], 30);
    expect(removed.html).toBe(clean.html);
    expect(removed.html).not.toContain(TRANSITION_BLOCK_ID);
  });

  it('normalizeClipWindows preserva overlaps declarados (round-trip estavel)', () => {
    const r = applyTimelineRestructure(PRISTINE_9S, SCENES_90, 30, [
      { id: 'scene-2', kind: 'fade', durationMs: 400 },
    ]);
    const norm = normalizeClipWindows(r.html, 30);
    expect(norm.warning).toBeNull();
    expect(norm.adjusted).toEqual([]);
    expect(norm.html).toBe(r.html);
    expect(lintClipWindows(norm.html)).toEqual([]);
  });
});

describe('F08.10 -- patch preserva transicoes+animacoes; restructure preserva animacoes', () => {
  const INNER = '<h1 id="scene-1-text-1" data-anim-in="riseIn">Hi</h1>';

  function stagedWithBoth() {
    const base = scenesHtml(
      [
        { id: 'scene-1', start: 0, duration: 3 },
        { id: 'scene-2', start: 3, duration: 3 },
        { id: 'scene-3', start: 6, duration: 3 },
      ],
      '9',
      INNER,
    );
    const r = applyTimelineRestructure(base, SCENES_90, 30, [
      { id: 'scene-2', kind: 'fade', durationMs: 400 },
    ]);
    const { document } = parseHTML(r.html);
    return upsertAnimBlock(r.html, collectAnimSpecs(document));
  }

  it('/patch (geom+decl) nao toca em blocos nem attrs de transicao/animacao', () => {
    const staged = stagedWithBoth();
    const { html, applied } = applyPatchesLinkedom(staged, [
      { selector: '#scene-1-text-1', property: 'x', value: '120' },
      { selector: '#scene-1-text-1', property: 'color', value: '#ff0000' },
    ]);
    expect(applied).toBe(2);
    expect(html.match(new RegExp('id="' + TRANSITION_BLOCK_ID + '"', 'g'))?.length).toBe(1);
    expect(html.match(new RegExp('id="' + ANIM_BLOCK_ID + '"', 'g'))?.length).toBe(1);
    expect(html).toContain('data-transition-out="fade@400"');
    expect(html).toContain('data-transition-in="fade@400"');
    expect(html).toContain('data-anim-in="riseIn"');
    expect(html).toMatch(/--el-x:\s*120px/);
    expect(lintClipWindows(html)).toEqual([]);
  });

  it('/restructure mantem o bloco de animacao (posicoes resolvidas em runtime)', () => {
    const base = scenesHtml(
      [
        { id: 'scene-1', start: 0, duration: 3 },
        { id: 'scene-2', start: 4, duration: 3 },
      ],
      '9',
      INNER,
    );
    const parsed = parseHTML(base);
    const withAnim = upsertAnimBlock(base, collectAnimSpecs(parsed.document));
    const r = applyTimelineRestructure(
      withAnim,
      [
        { id: 'scene-1', durationFrames: 90 },
        { id: 'scene-2', durationFrames: 90 },
      ],
      30,
      [{ id: 'scene-2', kind: 'dissolve', durationMs: 600 }],
    );
    expect(r.html.match(new RegExp('id="' + ANIM_BLOCK_ID + '"', 'g'))?.length).toBe(1);
    expect(r.html.match(new RegExp('id="' + TRANSITION_BLOCK_ID + '"', 'g'))?.length).toBe(1);
    expect(r.html).toContain('data-anim-in="riseIn"');
    expect(r.html).toContain('data-transition-out="dissolve@600"');
    expect(lintClipWindows(r.html)).toEqual([]);
  });
});describe('F08.10 -- registry v2 omite cenas e ignora data-transition-* (readonly)', () => {
  const REG = [
    '<!doctype html><html><body>',
    '<div data-composition-id="main" data-duration="9" data-width="1080" data-height="1920">',
    '  <div id="scene-1" class="clip" data-start="0" data-duration="3.4" data-transition-out="fade@400">',
    '    <h1 id="scene-1-text-1" data-anim-in="riseIn" data-transition-in="fade@400" style="left: 100px; top: 50px; width: 400px;">Ola</h1>',
    '    <img id="scene-1-img-1" src="assets/hero.jpg" />',
    '  </div>',
    '  <div id="scene-2" class="clip" data-start="3" data-duration="3" data-transition-in="fade@400">',
    '    <audio id="scene-2-voice-1" src="assets/v.mp3"></audio>',
    '  </div>',
    '  <audio id="bgm-main" src="assets/bgm.mp3"></audio>',
    '</div></body></html>',
  ].join('\n');

  it('cenas fora do inventario; nenhum elemento ganha campos de transicao', () => {
    const reg = deriveElements(REG, { revision: 11 });
    expect(reg.version).toBe(2);
    expect(reg.revision).toBe(11);
    const byId = new Map(reg.elements.map((e) => [e.id, e]));
    expect(byId.has('scene-1')).toBe(false);
    expect(byId.has('scene-2')).toBe(false);
    for (const el of reg.elements) {
      expect(el).not.toHaveProperty('transitionIn');
      expect(el).not.toHaveProperty('transitionOut');
    }
    expect(byId.get('scene-1-text-1')).toMatchObject({ type: 'text', animIn: 'riseIn', sceneId: 'scene-1' });
    expect(byId.get('bgm-main')).toMatchObject({ scope: 'composition', role: 'composition-audio' });
    expect(byId.get('scene-2-voice-1')).toMatchObject({ sceneId: 'scene-2' });
  });

  it('leitura v1 via adapter preservada (sem regressao F05)', () => {
    const v1 = { version: 1, elements: [{ id: 'text-a', type: 'text', sceneId: 'scene-1', text: 'Ola' }] };
    const v2 = normalizeRegistry(v1, { revision: 3 });
    expect(v2.version).toBe(2);
    expect(v2.elements[0]).toMatchObject({ id: 'text-a', type: 'text' });
    expect(v2.elements[0]).not.toHaveProperty('transitionIn');
  });
});

describe('F08.10 -- audio consciente de overlap (derivacao unica, replan sem corte)', () => {
  const withTrans = [
    '<!doctype html><html><body>',
    '<div data-composition-id="main" data-duration="9">',
    '  <div id="scene-1" class="clip" data-start="0" data-duration="3.4" data-transition-out="fade@400">',
    '    <audio id="scene-1-voice-1" src="assets/v1.mp3"></audio>',
    '  </div>',
    '  <div id="scene-2" class="clip" data-start="3" data-duration="3" data-transition-in="fade@400">',
    '    <audio id="scene-2-voice-1" src="assets/v2.mp3"></audio>',
    '  </div>',
    '  <audio id="bgm-main" data-role="music" src="assets/bgm.mp3"></audio>',
    '</div></body></html>',
  ].join('\n');
  const noTrans = withTrans.replace(/ data-transition-(in|out)="[^"]*"/g, '');

  it('overlap nao duplica clips: mesma derivacao com e sem transicoes', () => {
    const elsA = deriveElements(withTrans).elements;
    const elsB = deriveElements(noTrans).elements;
    const authored = { 'scene-1-voice-1': { volume: 0.9 } };
    const clipsA = deriveAudioClips(elsA, { authoredById: authored });
    const clipsB = deriveAudioClips(elsB, { authoredById: authored });
    expect(clipsA.map((c) => c.clipId)).toEqual(['scene-1-voice-1', 'scene-2-voice-1', 'bgm-main']);
    expect(clipsA).toEqual(clipsB);
    expect(clipsA.find((c) => c.clipId === 'bgm-main')?.scope).toBe('composition');
    expect(clipsA.find((c) => c.clipId === 'scene-1-voice-1')?.volume).toBe(0.9);
  });

  it('replan com janela estendida (overlap) nunca corta: overflow exige regenerate', () => {
    expect(
      replanVoiceWindows([{ clipId: 'v', windowStart: 0, windowEnd: 3.4, measuredDuration: 3.2 }]),
    ).toEqual({ ok: true });
    const r = replanVoiceWindows([{ clipId: 'v', windowStart: 0, windowEnd: 3, measuredDuration: 5.92 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.needsReplan[0].clipId).toBe('v');
      expect(r.needsReplan[0].overflowSec).toBeCloseTo(2.92, 8);
      expect(r.needsReplan[0].action).toBe('rewrite-regenerate');
    }
  });
});

describe('F08.10 -- helper hot-swap sem transicoes (estrutural via reload)', () => {
  it('helper re-aplica anim/keyframes/audio com paridade geom -- sem applier de transicoes', () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain('function __vpApplyAnimations');
    expect(PREVIEW_HELPER_SCRIPT).toContain('function __vpApplyKeyframes');
    expect(PREVIEW_HELPER_SCRIPT).toContain('function __vpApplyAudioProps');
    expect(PREVIEW_HELPER_SCRIPT).toContain('--el-x');
    expect(PREVIEW_HELPER_SCRIPT).toContain('function geomBaseline');
    expect(PREVIEW_HELPER_SCRIPT).not.toContain('__vpApplyTransitions');
    expect(PREVIEW_HELPER_SCRIPT).not.toContain('data-transition-in');
    expect(PREVIEW_HELPER_SCRIPT).not.toContain('data-transition-out');
  });

  it('PROP_MAP nao tem canal de transicao (transicoes nunca via /patch)', () => {
    for (const entry of Object.values(PROP_MAP)) {
      expect(entry.output.startsWith('data-transition')).toBe(false);
    }
    expect(PROP_MAP).not.toHaveProperty('transitionIn');
    expect(PROP_MAP).not.toHaveProperty('transitionOut');
  });
});
