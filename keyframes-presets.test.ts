// @vitest-environment node
/**
 * keyframes-presets.test.ts — V5-P8B (§13.2): keyframes leves materializados
 * em tweens GSAP reais no HTML persistido.
 *
 * Cobre:
 * 1. String canónica (paridade byte-a-byte com o espelho do app).
 * 2. Fonte aplicadora (`KEYFRAME_APPLY_SOURCE`) executada em sandbox vm com
 *    linkedom + gsap mockado: posicionamento por janela timed, clamping,
 *    kill determinístico (próprio + estrangeiro — keyframes vence presets),
 *    no-op sem gsap.
 * 3. collectKeyframeSpecs / upsertKeyframeBlock: specs derivadas do DOM, bloco
 *    único, idempotência, remoção, cap 4 keys.
 *
 * Doc: docs/video-engine/V5_P8B_KEYFRAMES.md §2.1–§2.2
 */
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import vm from 'node:vm';
import {
  KEYFRAME_ALLOWED_PROPS,
  KEYFRAME_CANONICAL_JSON,
  KEYFRAME_APPLY_SOURCE,
  KEYFRAME_BLOCK_ID,
  KEYFRAME_MAX_KEYS,
  collectKeyframeSpecs,
  buildKeyframeBlock,
  upsertKeyframeBlock,
} from './keyframes-presets.js';

const EXPECTED_CANONICAL = '["opacity","scale","x","y"]';

describe('KEYFRAME_ALLOWED_PROPS — tabela canónica (V5-P8B)', () => {
  it('serialização idêntica nos DOIS repos', () => {
    expect(KEYFRAME_CANONICAL_JSON).toBe(EXPECTED_CANONICAL);
  });

  it('cobre exactamente opacity/scale/x/y', () => {
    expect([...KEYFRAME_ALLOWED_PROPS]).toEqual(['opacity', 'scale', 'x', 'y']);
    expect(KEYFRAME_MAX_KEYS).toBe(4);
  });

  it('fonte aplicadora embute os marcadores de contrato', () => {
    expect(KEYFRAME_APPLY_SOURCE.startsWith('function __vpApplyKeyframes')).toBe(true);
    expect(KEYFRAME_APPLY_SOURCE).toContain('[data-kf]');
    expect(KEYFRAME_APPLY_SOURCE).toContain('__vpKeyframesApplied');
    expect(KEYFRAME_APPLY_SOURCE).toContain('[data-start]');
    expect(KEYFRAME_APPLY_SOURCE).toContain('fromTo');
    expect(() => new vm.Script(KEYFRAME_APPLY_SOURCE)).not.toThrow();
  });
});

// ─── Execução em sandbox ───────────────────────────────────────────────────

interface MockTween {
  vars: Record<string, unknown>;
  targets: () => unknown[];
  killed: boolean;
  kill(): void;
}

function makeMockGsap() {
  const timelines: Array<{
    calls: Array<{ m: string; target: unknown; from?: unknown; to?: unknown; pos?: number }>;
    children: MockTween[];
    times: number[];
    time(v?: number): number;
    paused?: boolean;
  }> = [];
  const gsap = {
    timeline(cfg: { paused?: boolean }) {
      const tl: {
        calls: Array<{ m: string; target: unknown; from?: unknown; to?: unknown; pos?: number }>;
        children: MockTween[];
        times: number[];
        time(v?: number): number;
        paused?: boolean;
        fromTo?: unknown;
        to?: unknown;
        getChildren?: unknown;
      } = {
        calls: [],
        children: [],
        times: [],
        time(v?: number) {
          if (v !== undefined) {
            tl.times.push(v);
          }
          const last = tl.times[tl.times.length - 1];
          return last ?? 0;
        },
        paused: cfg?.paused,
      };
      const track = (vars: Record<string, unknown>, target: unknown): MockTween => {
        const tw: MockTween = { vars, targets: () => [target], killed: false };
        tw.kill = () => { tw.killed = true; };
        return tw;
      };
      (tl as unknown as { fromTo: (t: unknown, f: unknown, to: Record<string, unknown>, p: number) => MockTween }).fromTo = (target, from, to, pos) => {
        tl.calls.push({ m: 'fromTo', target, from, to, pos });
        const tw = track({ ...to, startAt: { ...(from as object) } }, target);
        tl.children.push(tw);
        return tw;
      };
      (tl as unknown as { getChildren: () => MockTween[] }).getChildren = () => tl.children.slice();
      timelines.push(tl as typeof timelines[number]);
      return tl as unknown as Record<string, unknown>;
    },
  };
  return { gsap, timelines };
}

const FIXTURE = `<!doctype html>
<html><head></head><body>
<div id="main" data-composition-id="main" data-duration="10">
  <div id="sc1" class="clip" data-start="2" data-duration="4">
    <div id="scene-1-text-1" data-kf='[{"t":0,"x":10,"opacity":1},{"t":500,"x":30,"opacity":0.5}]'>a</div>
    <div id="scene-1-image-1" data-kf='[{"t":0,"y":5},{"t":1000,"y":50,"scale":1.2}]'>b</div>
  </div>
  <div id="sc2" class="clip" data-start="8" data-duration="2">
    <span id="scene-2-text-1" data-kf='[{"t":0,"x":0},{"t":400,"x":100}]'>c</span>
  </div>
  <p id="free-1" data-kf='[{"t":100,"opacity":1},{"t":900,"opacity":0}]'>d</p>
</div>
</body></html>`;

describe('__vpApplyKeyframes — execução (sandbox vm + gsap mock)', () => {
  it('fluxo completo: specs do DOM → fromTo sequenciais por janela timed', () => {
    const { document } = parseHTML(FIXTURE);
    const mock = makeMockGsap();
    const w: Record<string, unknown> = { __timelines: {} };
    const sb = { window: w, document, gsap: mock.gsap, isFinite, parseFloat, JSON };
    vm.createContext(sb);
    vm.runInContext(KEYFRAME_APPLY_SOURCE, sb, { filename: 'kf-apply.js' });
    vm.runInContext('__vpApplyKeyframes()', sb, { filename: 'kf-run.js' });

    const tl = mock.timelines[0];
    // 4 elementos × n-1 segmentos: scene-1-text-1(1) + scene-1-image-1(1) + scene-2-text-1(1) + free-1(1) = 4 tweens.
    expect(tl.calls.length).toBe(4);

    const forSel = (id: string) => tl.calls.filter((c) => (c.target as { id?: string })?.id === id);

    const t1 = forSel('scene-1-text-1')[0];
    expect(t1.m).toBe('fromTo');
    expect(t1.pos).toBeCloseTo(2, 5);
    expect(t1.from).toMatchObject({ x: 10, opacity: 1 });
    expect(t1.to).toMatchObject({ x: 30, opacity: 0.5, duration: 0.5, ease: 'none' });

    const t2 = forSel('scene-1-image-1')[0];
    expect(t2.pos).toBeCloseTo(2, 5);
    expect(t2.from).toMatchObject({ y: 5 });
    expect(t2.to).toMatchObject({ y: 50, scale: 1.2, duration: 1, ease: 'none' });

    const t3 = forSel('scene-2-text-1')[0];
    expect(t3.pos).toBeCloseTo(8, 5);
    expect(t3.to).toMatchObject({ duration: 0.4 });

    const t4 = forSel('free-1')[0];
    // free-1 sem host → ws=0.
    expect(t4.pos).toBeCloseTo(0.1, 5);
    expect(t4.from).toMatchObject({ opacity: 1 });
    expect(t4.to).toMatchObject({ opacity: 0, duration: 0.8 });

    expect((w.__vpKeyframesApplied as unknown[]).length).toBe(4);
  });

  it('clamp wd: dur encurtada quando o segmento ultrapassa a janela', () => {
    const html = `<div id="main" data-composition-id="main" data-duration="10"><div id="sc1" class="clip" data-start="0" data-duration="0.3"><b id="scene-1-text-1" data-kf='[{"t":0,"x":0},{"t":500,"x":100}]'>x</b></div></div>`;
    const { document } = parseHTML(html);
    const mock = makeMockGsap();
    const w: Record<string, unknown> = { __timelines: {} };
    const sb = { window: w, document, gsap: mock.gsap, isFinite, parseFloat, JSON };
    vm.createContext(sb);
    vm.runInContext(KEYFRAME_APPLY_SOURCE, sb, { filename: 'kf-apply.js' });
    vm.runInContext('__vpApplyKeyframes()', sb, { filename: 'kf-run.js' });
    const tl = mock.timelines[0];
    // wd=0.3, pos=0, dur solicitado 0.5 → clamped para ~0.3 (≥0.05).
    expect(tl.calls[0].to).toMatchObject({ duration: expect.closeTo(0.3, 2) });
  });

  it('killForeign: keyframes matam presets no mesmo elemento∩props; outros ficam', () => {
    const { document } = parseHTML(FIXTURE);
    const mock = makeMockGsap();
    const w: Record<string, unknown> = { __timelines: {} };
    const sb = { window: w, document, gsap: mock.gsap, isFinite, parseFloat, JSON };
    // Authored preset tween no headline (opacity/y) + tween órfão noutro elemento sem keyframes.
    const headline = document.querySelector('#scene-1-text-1');
    const orphan = document.getElementById('main'); // sem data-kf — specs não o tocam
    const pre = mock.gsap.timeline({ paused: true }) as unknown as {
      children: MockTween[];
      fromTo: (t: unknown, f: unknown, to: Record<string, unknown>, p: number) => MockTween;
      getChildren: () => MockTween[];
    };
    const killable = pre.fromTo(headline, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 1 }, 2);
    const keep = pre.fromTo(orphan, { x: 0 }, { x: 50, duration: 1 }, 8);
    (w as Record<string, unknown>).__timelines = { main: pre };
    vm.createContext(sb);
    vm.runInContext(KEYFRAME_APPLY_SOURCE, sb, { filename: 'kf-apply.js' });
    vm.runInContext('__vpApplyKeyframes()', sb, { filename: 'kf-run.js' });
    // keyframes da scene-1-text-1 tocam opacity/x → matam o preset do mesmo elemento∩props.
    expect(killable.killed).toBe(true);
    expect(keep.killed).toBe(false);
  });

  it('re-execução mata os PRÓPRIOS tweens antes de re-adicionar', () => {
    const html = `<div id="main" data-composition-id="main" data-duration="6"><b id="scene-1-text-1" data-kf='[{"t":0,"x":0},{"t":500,"x":100}]'>b</b></div>`;
    const { document } = parseHTML(html);
    const mock = makeMockGsap();
    const w: Record<string, unknown> = { __timelines: {} };
    const sb = { window: w, document, gsap: mock.gsap, isFinite, parseFloat, JSON };
    vm.createContext(sb);
    vm.runInContext(KEYFRAME_APPLY_SOURCE, sb, { filename: 'kf-apply.js' });
    const n1 = vm.runInContext('__vpApplyKeyframes().length', sb, { filename: 'r1.js' }) as number;
    expect(n1).toBe(1);
    const alive1 = mock.timelines[0].children.filter((c) => !c.killed);
    expect(alive1.length).toBe(1);
    vm.runInContext('__vpApplyKeyframes()', sb, { filename: 'r2.js' });
    const alive2 = mock.timelines[0].children.filter((c) => !c.killed);
    expect(alive2.length).toBe(1);
    expect(alive2[0]).not.toBe(alive1[0]);
  });

  it('sem gsap: no-op silencioso', () => {
    const { document } = parseHTML(`<div id="main" data-composition-id="main" data-duration="3"><i id="scene-1-text-1" data-kf='[{"t":0,"x":0},{"t":500,"x":100}]'>c</i></div>`);
    const w: Record<string, unknown> = { __timelines: {} };
    const sb = { window: w, document, isFinite, parseFloat, JSON };
    vm.createContext(sb);
    vm.runInContext(KEYFRAME_APPLY_SOURCE, sb, { filename: 'kf-apply.js' });
    const res = vm.runInContext('__vpApplyKeyframes()', sb, { filename: 'r.js' });
    expect(res).toEqual([]);
  });
});

describe('collectKeyframeSpecs — coleta determinística do DOM', () => {
  it('deriva specs ordenadas; ignora JSON inválido/sem motion/sem id', () => {
    const html = `<div id="main" data-composition-id="main" data-duration="9">
      <b id="scene-1-text-1" data-kf='[{"t":0,"x":10},{"t":500,"x":30}]'>a</b>
      <b id="scene-1-text-2" data-kf='not-json'>b</b>
      <b data-kf='[{"t":0,"x":1}]'>sem id</b>
      <b id="scene-1-text-3" data-kf='[{"t":0}]'>sem motion</b>
      <b id="scene-1-text-4" data-kf='[]'>vazio</b>
    </div>`;
    const { document } = parseHTML(html);
    const specs = collectKeyframeSpecs(document);
    expect(specs.length).toBe(1);
    expect(specs[0].sel).toBe('#scene-1-text-1');
    expect(specs[0].frames.length).toBe(2);
  });
});

describe('upsertKeyframeBlock — bloco único, idempotente, removível', () => {
  const SPECS: Array<{ sel: string; frames: unknown[] }> = [{ sel: '#scene-1-text-1', frames: [{ t: 0, x: 10 } as never, { t: 500, x: 30 } as never] }];
  const HTML = `<html><body><div id="scene-1-text-1">x</div></body></html>`;

  it('insere UM bloco estático antes de </body>', () => {
    const out = upsertKeyframeBlock(HTML, SPECS as never);
    expect(out.match(new RegExp(`id="${KEYFRAME_BLOCK_ID}"`, 'g'))?.length).toBe(1);
    expect(out.indexOf(KEYFRAME_BLOCK_ID)).toBeLessThan(out.search(/<\/body>/i));
    expect(out).not.toContain('__vpKeyframeSpecs');
    expect(out).toContain('__vpApplyKeyframes()');
  });

  it('re-aplicação converge byte-exato', () => {
    const once = upsertKeyframeBlock(HTML, SPECS as never);
    const twice = upsertKeyframeBlock(once, SPECS as never);
    expect(twice).toBe(once);
  });

  it('zero specs remove o bloco', () => {
    const withBlock = upsertKeyframeBlock(HTML, SPECS as never);
    const cleaned = upsertKeyframeBlock(withBlock, []);
    expect(cleaned).not.toContain(KEYFRAME_BLOCK_ID);
    expect(upsertKeyframeBlock(cleaned, [])).toBe(cleaned);
  });

  it('bloco compila sem executar', () => {
    const block = buildKeyframeBlock(SPECS as never);
    const body = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    expect(() => new vm.Script(body)).not.toThrow();
  });
});
