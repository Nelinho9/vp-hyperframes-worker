// @vitest-environment node
/**
 * anim-presets.test.ts — V5-P1D (§6.4): tabela canónica de presets de
 * animação + bloco materializado no HTML persistido.
 *
 * Cobre:
 * 1. String canónica da tabela (paridade byte-a-byte com o espelho do app).
 * 2. Fonte aplicadora (`ANIM_APPLY_SOURCE`) executada em sandbox vm com
 *    linkedom + gsap mockado: posicionamento absoluto por janela timed,
 *    eases, clamping, kill determinístico (próprio + estrangeiro), no-op sem
 *    gsap.
 * 3. collectAnimSpecs / upsertAnimBlock: specs derivadas do DOM, bloco único,
 *    idempotência, remoção quando não há specs.
 *
 * Doc: docs/video-engine/V5_P1D_ANIMACOES_INSPECTOR.md §2
 */
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import vm from 'node:vm';
import {
  ANIM_TWEENS,
  ANIM_TWEENS_CANONICAL_JSON,
  ANIM_APPLY_SOURCE,
  ANIM_BLOCK_ID,
  collectAnimSpecs,
  buildAnimBlock,
  upsertAnimBlock,
} from './anim-presets.js';

/** String canónica — hardcode idêntico ao teste do app (paridade CI). */
const EXPECTED_CANONICAL =
  '{"in":{"fade":{"from":{"opacity":0},"to":{"opacity":1},"ease":"power2.out"},"riseIn":{"from":{"opacity":0,"y":40},"to":{"opacity":1,"y":0},"ease":"power2.out"},"zoomIn":{"from":{"opacity":0,"scale":0.85},"to":{"opacity":1,"scale":1},"ease":"power2.out"},"slideLeft":{"from":{"opacity":0,"x":60},"to":{"opacity":1,"x":0},"ease":"power2.out"},"popIn":{"from":{"opacity":0,"scale":0.5},"to":{"opacity":1,"scale":1},"ease":"back.out(1.8)"}},"out":{"fade":{"to":{"opacity":0},"ease":"power2.in"},"sinkOut":{"to":{"opacity":0,"y":30},"ease":"power2.in"},"zoomOut":{"to":{"opacity":0,"scale":1.12},"ease":"power2.in"},"slideRight":{"to":{"opacity":0,"x":60},"ease":"power2.in"}}}';

describe('ANIM_TWEENS — tabela canónica (V5-P1D)', () => {
  it('serialização idêntica nos DOIS repos', () => {
    expect(ANIM_TWEENS_CANONICAL_JSON).toBe(EXPECTED_CANONICAL);
  });

  it('presets in/out cobrem exatamente o modelo §6.1', () => {
    expect(Object.keys(ANIM_TWEENS.in)).toEqual([
      'fade', 'riseIn', 'zoomIn', 'slideLeft', 'popIn',
    ]);
    expect(Object.keys(ANIM_TWEENS.out)).toEqual([
      'fade', 'sinkOut', 'zoomOut', 'slideRight',
    ]);
    for (const table of [ANIM_TWEENS.in, ANIM_TWEENS.out]) {
      for (const preset of Object.values(table)) {
        // Só transform + opacity — nunca left/top/display/visibility.
        const keys = [...Object.keys(preset.from ?? {}), ...Object.keys(preset.to)];
        for (const k of keys) {
          expect(['opacity', 'x', 'y', 'scale']).toContain(k);
        }
        expect(typeof preset.ease).toBe('string');
      }
    }
  });

  it('fonte aplicadora embute a tabela e os marcadores de contrato', () => {
    expect(ANIM_APPLY_SOURCE.startsWith('function __vpApplyAnimations')).toBe(true);
    expect(ANIM_APPLY_SOURCE).toContain('[data-anim-in]');
    expect(ANIM_APPLY_SOURCE).toContain('__vpAnimApplied');
    expect(ANIM_APPLY_SOURCE).toContain('[data-start]');
    expect(ANIM_APPLY_SOURCE).toContain('back.out(1.8)');
    expect(() => new vm.Script(ANIM_APPLY_SOURCE)).not.toThrow();
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
      (tl as Partial<Record<string, unknown>>).paused = cfg?.paused;
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
      (tl as unknown as {
        getChildren: () => MockTween[];
      }).getChildren = () => tl.children.slice();
      timelines.push(tl);
      return tl as unknown as Record<string, unknown>;
    },
  };
  return { gsap, timelines };
}

const FIXTURE = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div id="main" data-composition-id="main" data-duration="15">
  <div id="sc1" class="clip" data-start="8.5" data-duration="2">
    <h1 id="text-headline-1" data-anim-in="riseIn" data-anim-delay-ms="120">H</h1>
  </div>
  <div id="sc2" class="clip" data-start="12" data-duration="1.5">
    <img id="img-hero" data-anim-out="fade" data-anim-dur-ms="400" />
  </div>
  <div id="sc3" class="clip" data-start="14" data-duration="0.5">
    <span id="text-mini-1" data-anim-in="zoomIn">m</span>
  </div>
  <p id="text-solo-1" data-anim-in="popIn">S</p>
  <p id="text-tail-1" data-anim-out="sinkOut">T</p>
</div>
</body>
</html>`;

function specsFromHtml(html: string) {
  const { document } = parseHTML(html);
  return collectAnimSpecs(document);
}

describe('__vpApplyAnimations — execução (sandbox vm + gsap mock)', () => {
  it('fluxo completo: specs do DOM → tweens esperados na timeline "main"', () => {
    const { document } = parseHTML(FIXTURE);
    const mock = makeMockGsap();
    const w: Record<string, unknown> = { __timelines: {} };
    const sandbox = { window: w, document, gsap: mock.gsap, isFinite, parseFloat };
    vm.createContext(sandbox);
    vm.runInContext(ANIM_APPLY_SOURCE, sandbox, { filename: 'vp-anim-apply.js' });
    vm.runInContext('__vpApplyAnimations()', sandbox, { filename: 'vp-anim-run.js' });

    const tl = mock.timelines[0];
    expect(tl.calls.length).toBe(5);

    const byTargetId = (id: string) =>
      tl.calls.filter((c) => (c.target as { id?: string })?.id === id);

    // riseIn dentro de #sc1 (start 8.5, dur 2) com delay 120ms.
    const rise = byTargetId('text-headline-1')[0];
    expect(rise.m).toBe('fromTo');
    expect(rise.pos).toBeCloseTo(8.62, 5);
    expect(rise.from).toEqual({ opacity: 0, y: 40 });
    expect(rise.to).toMatchObject({ opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' });

    // fade out dentro de #sc2: posição = fim da janela − duração.
    const fadeOut = byTargetId('img-hero')[0];
    expect(fadeOut.m).toBe('to');
    expect(fadeOut.pos).toBeCloseTo(13.1, 5);
    expect(fadeOut.to).toMatchObject({ opacity: 0, duration: 0.4, ease: 'power2.in' });

    // zoomIn numa janela curta (0.5s): duração clamped para caber.
    const zoom = byTargetId('text-mini-1')[0];
    expect(zoom.pos).toBe(14);
    expect(zoom.to).toMatchObject({ duration: 0.5, ease: 'power2.out' });

    // popIn sem host timed: posição = delay (0); ease back.
    const pop = byTargetId('text-solo-1')[0];
    expect(pop.pos).toBe(0);
    expect(pop.to).toMatchObject({ scale: 1, ease: 'back.out(1.8)' });

    // sinkOut sem janela: ancora ao FIM da composição (root 15 − 0.6).
    const sink = byTargetId('text-tail-1')[0];
    expect(sink.pos).toBeCloseTo(14.4, 5);

    // Registry de aplicados preenchido.
    expect((w.__vpAnimApplied as unknown[]).length).toBe(5);
  });

  it('timeline ausente é criada pausada e registada sob a composition id', () => {
    const html = `<div id="c1" data-composition-id="proj-x" data-duration="4"><b id="text-a" data-anim-in="fade">a</b></div>`;
    const { document } = parseHTML(html);
    const mock = makeMockGsap();
    const w: Record<string, unknown> = { __timelines: {} };
    const sandbox = { window: w, document, gsap: mock.gsap, isFinite, parseFloat };
    vm.createContext(sandbox);
    vm.runInContext(ANIM_APPLY_SOURCE, sandbox, { filename: 'vp-anim-apply.js' });
    vm.runInContext('__vpApplyAnimations()', sandbox, { filename: 'vp-anim-run.js' });

    expect(mock.timelines[0].paused).toBe(true);
    const reg = w.__timelines as Record<string, unknown>;
    expect(reg['proj-x']).toBeTruthy();
    expect(mock.timelines[0].calls.length).toBe(1);
  });

  it('re-execução mata os PRÓPRIOS tweens anteriores antes de re-adicionar', () => {
    const html = `<div id="main" data-composition-id="main" data-duration="6"><b id="text-b" data-anim-in="fade">b</b></div>`;
    const { document } = parseHTML(html);
    const mock = makeMockGsap();
    const w: Record<string, unknown> = { __timelines: {} };
    const sandbox = { window: w, document, gsap: mock.gsap, isFinite, parseFloat };
    vm.createContext(sandbox);
    vm.runInContext(ANIM_APPLY_SOURCE, sandbox, { filename: 'vp-anim-apply.js' });

    const firstCount = vm.runInContext('__vpApplyAnimations().length', sandbox, { filename: 'r1.js' }) as number;
    expect(firstCount).toBe(1);
    const survivorsAfterFirst = mock.timelines[0].children.filter((c) => !c.killed);
    expect(survivorsAfterFirst.length).toBe(1);

    vm.runInContext('__vpApplyAnimations()', sandbox, { filename: 'r2.js' });
    // O tween da primeira execução foi morto; só o novo permanece vivo.
    const alive = mock.timelines[0].children.filter((c) => !c.killed);
    expect(alive.length).toBe(1);
    expect(alive[0]).not.toBe(survivorsAfterFirst[0]);
  });

  it('kill estrangeiro: tween authored no mesmo elemento∩props morre; outros elementos ficam', () => {
    const { document } = parseHTML(FIXTURE);
    const mock = makeMockGsap();
    const w: Record<string, unknown> = { __timelines: {} };
    const sandbox = { window: w, document, gsap: mock.gsap, isFinite, parseFloat };
    vm.createContext(sandbox);

    // Authored: entrance no headline (opacity/y) + slow zoom no img-hero.
    // As specs derivam do DOM: o headline tem riseIn (opacity/y → mata o
    // entrance authored); o img-hero tem fade out (só opacity → o slow zoom
    // em scale NÃO é tocado).
    const headline = document.querySelector('#text-headline-1');
    const bg = document.querySelector('#img-hero');
    const preMain = mock.gsap.timeline({ paused: true });
    const authoredHeadline = preMain.fromTo(headline, { opacity: 0.5, y: 30 }, { opacity: 1, y: 0, duration: 1 }, 8.6);
    const authoredZoom = preMain.to(bg, { scale: 1.05, duration: 3, ease: 'none' }, 12);
    w.__timelines = { main: preMain };

    vm.runInContext(ANIM_APPLY_SOURCE, sandbox, { filename: 'vp-anim-apply.js' });
    vm.runInContext('__vpApplyAnimations()', sandbox, { filename: 'vp-anim-run.js' });

    expect(authoredHeadline.killed).toBe(true);
    expect(authoredZoom.killed).toBe(false);
  });

  it('sem gsap global: no-op silencioso', () => {
    const { document } = parseHTML(`<div id="m" data-composition-id="m" data-duration="3"><i id="text-c" data-anim-in="fade">c</i></div>`);
    const w: Record<string, unknown> = { __timelines: {} };
    const sandbox = { window: w, document, isFinite, parseFloat };
    vm.createContext(sandbox);
    vm.runInContext(ANIM_APPLY_SOURCE, sandbox, { filename: 'vp-anim-apply.js' });
    const res = vm.runInContext('__vpApplyAnimations()', sandbox, { filename: 'r.js' });
    expect(res).toEqual([]);
  });
});

// ─── collectAnimSpecs / upsertAnimBlock ─────────────────────────────────────

describe('collectAnimSpecs — coleta determinística do DOM', () => {
  it('deriva specs com chaves em ordem fixa; ignora none/inválidos/sem id', () => {
    const html = `<div id="main" data-composition-id="main" data-duration="9">
      <b id="text-1" data-anim-in="riseIn" data-anim-dur-ms="700" data-anim-delay-ms="80">a</b>
      <b id="text-2" data-anim-in="none" data-anim-out="fade">b</b>
      <b data-anim-in="fade">sem id</b>
      <b id="text-4" data-anim-in="fakePreset">inválido</b>
      <video id="video-9" data-anim-out="slideRight"></video>
    </div>`;
    const specs = specsFromHtml(html);
    expect(specs).toEqual([
      { sel: '#text-1', in: 'riseIn', dur: 700, delay: 80 },
      { sel: '#text-2', out: 'fade' },
      { sel: '#video-9', out: 'slideRight' },
    ]);
  });

  it('lista vazia quando nada tem preset ativo', () => {
    expect(specsFromHtml(`<div><b id="a" data-anim-in="none"></b></div>`)).toEqual([]);
    expect(specsFromHtml(`<div><b id="a"></b></div>`)).toEqual([]);
  });
});

describe('upsertAnimBlock — bloco único, estático, idempotente, removível', () => {
  const SPECS = [{ sel: '#text-1', in: 'riseIn' }];
  const HTML = `<html><body><div id="text-1">x</div></body></html>`;

  it('insere UM bloco (conteúdo ESTÁTICO) antes de </body>', () => {
    const out = upsertAnimBlock(HTML, SPECS);
    expect(out.match(new RegExp(`id="${ANIM_BLOCK_ID}"`, 'g'))?.length).toBe(1);
    expect(out.indexOf(ANIM_BLOCK_ID)).toBeLessThan(out.search(/<\/body>/i));
    // Sem payload JSON — as specs derivam do DOM em runtime.
    expect(out).not.toContain('__vpAnimSpecs');
    expect(out).toContain('__vpApplyAnimations()');
  });

  it('re-aplicação converge byte-exato (idempotente)', () => {
    const once = upsertAnimBlock(HTML, SPECS);
    const twice = upsertAnimBlock(once, SPECS);
    expect(twice).toBe(once);
  });

  it('bloco anterior é SUBSTITUÍDO (nunca duplicado)', () => {
    const once = upsertAnimBlock(HTML, SPECS);
    const updated = upsertAnimBlock(once, [{ sel: '#text-1', out: 'fade' }]);
    expect(updated.match(new RegExp(`id="${ANIM_BLOCK_ID}"`, 'g'))?.length).toBe(1);
    expect(updated).toBe(once); // conteúdo estático: mesmas bytes
  });

  it('zero specs remove o bloco existente (HTML limpo)', () => {
    const withBlock = upsertAnimBlock(HTML, SPECS);
    const cleaned = upsertAnimBlock(withBlock, []);
    expect(cleaned).not.toContain(ANIM_BLOCK_ID);
    expect(cleaned).not.toContain('__vpApplyAnimations');
    // E remover de novo continua estável.
    expect(upsertAnimBlock(cleaned, [])).toBe(cleaned);
  });

  it('bloco é JavaScript válido (compila sem executar)', () => {
    const block = buildAnimBlock(SPECS);
    const body = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    expect(() => new vm.Script(body)).not.toThrow();
  });
});
