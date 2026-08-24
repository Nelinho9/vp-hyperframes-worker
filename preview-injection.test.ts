// @vitest-environment node
/**
 * preview-injection.test.ts — V4-3f.3 (A3): click-to-edit helper injection
 *
 * Covers:
 * 1. injectPreviewHelper: injects before </body>, idempotent, tolerates
 *    missing </body>.
 * 2. Helper script contract: selection protocol + hot-swap receiver markers.
 * 3. HTTP: GET /preview/:id serves the composition WITH the helper injected
 *    (via mode:'preview' staging — no HyperFrames CLI invoked).
 *
 * Note: the aspirational server.contract.test.ts targets a createWorkerApp
 * refactor (V4-1 TDD spec) that was never implemented in server.js; it stays
 * out of the default test run until that refactor lands.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { app } from './server.js';
import {
  injectPreviewHelper,
  injectPreviewRuntime,
  RUNTIME_SCRIPT_MARKER,
  PREVIEW_HELPER_SCRIPT,
  HELPER_SCRIPT_ID,
} from './preview-helper.js';
import { createPreviewToken } from './preview-token.js';

const COMPOSITION_HTML = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div data-composition-id="main">
  <h1 id="text-headline-1">Hello</h1>
  <img id="img-hero" src="assets/hero.jpg" />
</div>
</body>
</html>`;

let server: http.Server;
let base: string;

// server.js is plain JS — the static import infers loosely; narrow to the
// surface the tests use (same pattern as job-persistence.test.ts).
const workerApp = app as unknown as {
  listen: (port: number, host: string) => http.Server;
};

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = workerApp.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('injectPreviewHelper — unit', () => {
  it('injeta o helper antes de </body>', () => {
    const out = injectPreviewHelper(COMPOSITION_HTML);
    expect(out).toContain(`id="${HELPER_SCRIPT_ID}"`);
    // Helper appears before the closing body tag.
    expect(out.indexOf(HELPER_SCRIPT_ID)).toBeLessThan(out.search(/<\/body>/i));
    // Original composition untouched.
    expect(out).toContain('data-composition-id="main"');
    expect(out).toContain('<h1 id="text-headline-1">Hello</h1>');
  });

  it('é idempotente (não duplica o helper)', () => {
    const once = injectPreviewHelper(COMPOSITION_HTML);
    const twice = injectPreviewHelper(once);
    expect(twice).toBe(once);
  });

  it('aceita HTML sem </body> (acrescenta no fim)', () => {
    const out = injectPreviewHelper('<div id="text-x">sem body</div>');
    expect(out).toContain(`id="${HELPER_SCRIPT_ID}"`);
    expect(out.startsWith('<div id="text-x">sem body</div>')).toBe(true);
  });

  it('devolve input inválido sem alterações', () => {
    expect(injectPreviewHelper('')).toBe('');
    expect(injectPreviewHelper(null as unknown as string)).toBe(null);
  });
});

describe('PREVIEW_HELPER_SCRIPT — contrato do protocolo', () => {
  it('implementa seleção por click com postMessage select/deselect', () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("closest('[id],[data-hf-id]')");
    expect(PREVIEW_HELPER_SCRIPT).toContain("action: 'select'");
    expect(PREVIEW_HELPER_SCRIPT).toContain("action: 'deselect'");
    expect(PREVIEW_HELPER_SCRIPT).toContain('getBoundingClientRect()');
    expect(PREVIEW_HELPER_SCRIPT).toContain('bbox');
  });

  it('implementa o recetor hot-swap patch/seek/playpause', () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("data.action === 'patch'");
    expect(PREVIEW_HELPER_SCRIPT).toContain("data.action === 'seek'");
    expect(PREVIEW_HELPER_SCRIPT).toContain("data.action === 'playpause'");
    // Patch semantics mirror prop-map.js / patchHtml.ts (V5-P0B).
    expect(PREVIEW_HELPER_SCRIPT).toContain('textContent');
    expect(PREVIEW_HELPER_SCRIPT).toContain("setAttribute('src'");
    expect(PREVIEW_HELPER_SCRIPT).toContain('background-image');
    expect(PREVIEW_HELPER_SCRIPT).toContain('style.setProperty');
    // V5-P0B geometry: --el-* vars + individual transforms, NEVER left/top.
    expect(PREVIEW_HELPER_SCRIPT).toContain('"x":{"output":"--el-x"');
    expect(PREVIEW_HELPER_SCRIPT).toContain('"y":{"output":"--el-y"');
    expect(PREVIEW_HELPER_SCRIPT).not.toContain('"x":"left"');
    expect(PREVIEW_HELPER_SCRIPT).not.toContain('"y":"top"');
    // Delta baseline capture + consumption declarations present.
    expect(PREVIEW_HELPER_SCRIPT).toContain('getBoundingClientRect()');
    expect(PREVIEW_HELPER_SCRIPT).toContain('GEOM_BASELINES');
    expect(PREVIEW_HELPER_SCRIPT).toContain('var(--el-x, 0px) var(--el-y, 0px)');
    // V5-P1A: animação via atributos data-anim-*; UI-only filtrado.
    expect(PREVIEW_HELPER_SCRIPT).toContain('"animIn":{"output":"data-anim-in"');
    expect(PREVIEW_HELPER_SCRIPT).toContain('UI_ONLY_PROPS');
  });

  it('implementa o modo edit inline de texto (V5-P1B)', () => {
    // Duplo-click entra em modo edit num elemento de texto.
    expect(PREVIEW_HELPER_SCRIPT).toContain("'dblclick'");
    expect(PREVIEW_HELPER_SCRIPT).toContain("setAttribute('contenteditable'");
    expect(PREVIEW_HELPER_SCRIPT).toContain("removeAttribute('contenteditable'");
    // Envelopes novos iframe → pai (action via elementEnvelope).
    expect(PREVIEW_HELPER_SCRIPT).toContain("'edit-start'");
    expect(PREVIEW_HELPER_SCRIPT).toContain("'text-input'");
    expect(PREVIEW_HELPER_SCRIPT).toContain("'edit-end'");
    // Commit por blur/Enter/Esc; Esc restaura o texto original.
    expect(PREVIEW_HELPER_SCRIPT).toContain("'Escape'");
    expect(PREVIEW_HELPER_SCRIPT).toContain("'Enter'");
    // Debounce do input é drenado no commit (sem mensagens tardias).
    expect(PREVIEW_HELPER_SCRIPT).toContain('clearTimeout');
    // Eco suprimido no recetor patch durante edição.
    expect(PREVIEW_HELPER_SCRIPT).toContain('activeEditor');
  });

  it('é JavaScript válido (compila sem executar)', () => {
    // vm.Script only parses/compiles the static helper source — never runs it.
    expect(() => new vm.Script(PREVIEW_HELPER_SCRIPT)).not.toThrow();
  });
});

// ─── Comportamento real do helper (executado numa sandbox vm) ──────────────

interface BootedHelper {
  document: ReturnType<typeof parseHTML>['document'];
  parentMessages: unknown[];
  click: (target: unknown) => void;
  /** V5-P1B: dblclick manual (mesmo padrão do click — só ev.target é lido). */
  dblclick: (target: unknown) => void;
  message: (data: unknown) => void;
  /**
   * V5-P1B: drena os timers pendentes do sandbox (debounce do input) —
   * determinístico, sem depender de fake timers globais.
   */
  runTimers: () => void;
}

/** Execute the helper script against a linkedom document inside a VM. */
function bootHelper(html: string): BootedHelper {
  const { document } = parseHTML(html);
  const parentMessages: unknown[] = [];
  const messageListeners: ((ev: unknown) => void)[] = [];
  const docListeners: Record<string, ((ev: unknown) => void)[]> = {};

  // V5-P1B: the REAL linkedom document is handed to the sandbox so events
  // dispatched on elements (input/keydown bubble; blur direto) alcançam os
  // listeners registados pelo helper. addEventListener é embrulhado para
  // registar também os callbacks (firing manual do click/dblclick).
  type DocWithListeners = {
    addEventListener: (type: string, fn: (ev: unknown) => void) => void;
    querySelector: (sel: string) => unknown;
    createRange?: () => unknown;
  };
  const realDoc = document as unknown as DocWithListeners;
  const origDocAdd = realDoc.addEventListener.bind(realDoc);
  Object.defineProperty(realDoc, 'addEventListener', {
    value: (type: string, fn: (ev: unknown) => void) => {
      (docListeners[type] ??= []).push(fn);
      origDocAdd(type, fn);
    },
    configurable: true,
  });

  // Timers manuais do sandbox: o debounce do modo edit fica sob controlo do
  // teste (runTimers), sem fake timers globais.
  const pendingTimers = new Map<number, () => void>();
  let timerSeq = 0;

  const sandboxWindow = {
    postMessage: () => {},
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      if (type === 'message') messageListeners.push(fn);
    },
    // getSelection intencionalmente ausente — o caminho do caret degrada
    // para el.focus() (guard no helper).
  };
  const sandbox = {
    window: sandboxWindow,
    // The helper uses querySelector/addEventListener/createRange on the
    // document; elementos reais suportam dispatchEvent (testes de edição).
    document: realDoc,
    parent: { postMessage: (m: unknown) => parentMessages.push(m) },
    setTimeout: (fn: () => void) => {
      const id = ++timerSeq;
      pendingTimers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => {
      pendingTimers.delete(id);
    },
    // NOTE: intrinsics (Object/JSON/WeakMap/…) come from the fresh VM
    // context itself — passing HOST intrinsics here breaks contextification.
  };
  sandboxWindow.window = sandboxWindow;
  vm.createContext(sandbox);
  // NOTE: run the source string DIRECTLY (with a filename) — creating an
  // extra `vm.Script` for already-compiled source trips a V8 double-compile
  // quirk under worker threads ("Unexpected identifier").
  vm.runInContext(PREVIEW_HELPER_SCRIPT, sandbox, { filename: 'vp-preview-helper.js' });

  return {
    document,
    parentMessages,
    click: (target: unknown) =>
      (docListeners.click ?? []).forEach((fn) => fn({ target })),
    dblclick: (target: unknown) =>
      (docListeners.dblclick ?? []).forEach((fn) => fn({ target })),
    message: (data: unknown) => messageListeners.forEach((fn) => fn({ data })),
    runTimers: () => {
      const fns = [...pendingTimers.values()];
      pendingTimers.clear();
      fns.forEach((fn) => fn());
    },
  };
}

describe('PREVIEW_HELPER_SCRIPT — geometria em execução (V5-P0B)', () => {
  it('converte x/y absolutos em deltas vs baseline rect e escreve vars+consumo', () => {
    const h = bootHelper('<div id="el" style="width: 10px;"></div>');
    const el = h.document.querySelector('#el');

    // First geometry session — linkedom rects are (0,0), so delta == absolute.
    h.message({
      action: 'patch',
      patches: [
        { selector: '#el', property: 'x', value: '100' },
        { selector: '#el', property: 'y', value: '50' },
      ],
    });
    const style = el!.getAttribute('style') ?? '';
    expect(style).toMatch(/--el-x:\s*100px/);
    expect(style).toMatch(/--el-y:\s*50px/);
    // linkedom serializes style without separator spacing → whitespace-tolerant.
    expect(style).toMatch(/translate\s*:\s*var\(--el-x,\s*0px\)\s+var\(--el-y,\s*0px\)/);
    // No layout literals written by the helper.
    expect(style).not.toMatch(/\bleft\s*:/);

    // Second session on the SAME element: baseline is cached, the new
    // absolute target replaces the accumulated delta (fixed point).
    h.message({ action: 'patch', patches: [{ selector: '#el', property: 'x', value: '160' }] });
    expect(el!.getAttribute('style')).toMatch(/--el-x:\s*160px/);
    expect(el!.getAttribute('style')).not.toMatch(/--el-x:\s*260px/);
  });

  it('width/height são absolutos; rotation usa deg; decl props mantêm px', () => {
    const h = bootHelper('<div id="badge-1">B</div>');
    h.message({
      action: 'patch',
      patches: [
        { selector: '#badge-1', property: 'width', value: '420' },
        { selector: '#badge-1', property: 'height', value: '280' },
        { selector: '#badge-1', property: 'rotation', value: '-12.5' },
        { selector: '#badge-1', property: 'size', value: '72' },
      ],
    });
    const style = h.document.querySelector('#badge-1')!.getAttribute('style') ?? '';
    expect(style).toMatch(/--el-w:\s*420px/);
    expect(style).toMatch(/--el-h:\s*280px/);
    expect(style).toMatch(/width\s*:\s*var\(--el-w\)/);
    expect(style).toMatch(/height\s*:\s*var\(--el-h\)/);
    expect(style).toMatch(/--el-rotate:\s*-12\.5deg/);
    expect(style).toMatch(/rotate\s*:\s*var\(--el-rotate,\s*0deg\)/);
    // Non-geometry decl prop unchanged (size → font-size +px).
    expect(style).toMatch(/font-size\s*:\s*72px/);
  });

  it('seleção por click continua a reportar bbox ao pai (regressão)', () => {
    const h = bootHelper('<div id="text-headline-1">Olá</div>');
    h.click(h.document.querySelector('#text-headline-1'));
    const select = h.parentMessages.find(
      (m) => (m as { action?: string }).action === 'select',
    ) as { elementId: string; bbox: { x: number; y: number; w: number; h: number } };
    expect(select).toBeTruthy();
    expect(select.elementId).toBe('text-headline-1');
    // linkedom has no layout — rects are zeroed, but the envelope is intact.
    expect(select.bbox).toEqual({ x: 0, y: 0, w: 0, h: 0 });

    h.click(null);
    expect(h.parentMessages).toContainEqual({ action: 'deselect' });
  });
});

describe('PREVIEW_HELPER_SCRIPT — modelo expandido em execução (V5-P1A)', () => {
  it('novos decl props escrevem CSS com unidades da tabela', () => {
    const h = bootHelper('<div id="text-headline-1">H</div><img id="img-hero" />');
    h.message({
      action: 'patch',
      patches: [
        { selector: '#text-headline-1', property: 'align', value: 'right' },
        { selector: '#text-headline-1', property: 'letterSpacing', value: '2' },
        { selector: '#text-headline-1', property: 'lineHeight', value: '1.2' },
        { selector: '#img-hero', property: 'radius', value: '16' },
        { selector: '#img-hero', property: 'fit', value: 'contain' },
      ],
    });
    const textStyle = h.document.querySelector('#text-headline-1')!.getAttribute('style') ?? '';
    expect(textStyle).toMatch(/text-align\s*:\s*right/);
    expect(textStyle).toMatch(/letter-spacing\s*:\s*2px/);
    // Multiplicador numérico fica unitless.
    expect(textStyle).toMatch(/line-height\s*:\s*1\.2(?!px)/);
    const imgStyle = h.document.querySelector('#img-hero')!.getAttribute('style') ?? '';
    expect(imgStyle).toMatch(/border-radius\s*:\s*16px/);
    expect(imgStyle).toMatch(/object-fit\s*:\s*contain/);
  });

  it("'text' é alias de textContent; animação escreve atributos data-anim-*", () => {
    const h = bootHelper('<div id="text-headline-1">Old</div>');
    h.message({
      action: 'patch',
      patches: [
        { selector: '#text-headline-1', property: 'text', value: 'Novo headline' },
        { selector: '#text-headline-1', property: 'animIn', value: 'riseIn' },
        { selector: '#text-headline-1', property: 'animDurMs', value: '600' },
      ],
    });
    const el = h.document.querySelector('#text-headline-1')!;
    expect(el.textContent).toBe('Novo headline');
    expect(el.getAttribute('data-anim-in')).toBe('riseIn');
    expect(el.getAttribute('data-anim-dur-ms')).toBe('600');
    // Nenhum vazamento para o estilo inline.
    expect(el.getAttribute('style') ?? '').not.toMatch(/anim/i);
  });

  it('props UI-only são ignoradas sem tocar no elemento (aceitação P1 #4)', () => {
    const h = bootHelper('<img id="img-hero" src="a.jpg" /><video id="video-1"></video>');
    h.message({
      action: 'patch',
      patches: [
        { selector: '#img-hero', property: 'autoAspect', value: 'true' },
        { selector: '#video-1', property: 'volume', value: '0.8' },
        { selector: '#video-1', property: 'trimStart', value: '10' },
      ],
    });
    expect(h.document.querySelector('#img-hero')!.getAttribute('style')).toBeNull();
    expect(h.document.querySelector('#video-1')!.getAttribute('style')).toBeNull();
  });
});

/** Dispara um evento real num elemento linkedom (bubbles; key opcional p/ keydown). */
function fireElementEvent(
  h: BootedHelper,
  el: unknown,
  type: string,
  opts?: { key?: string },
): { defaultPrevented: boolean } {
  const EventCtor = h.document.defaultView!.Event as unknown as {
    new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }): Event & { key?: string };
  };
  const ev = new EventCtor(type, { bubbles: true, cancelable: Boolean(opts?.key) });
  if (opts?.key) ev.key = opts.key;
  (el as { dispatchEvent: (e: unknown) => boolean }).dispatchEvent(ev);
  return { defaultPrevented: ev.defaultPrevented };
}

describe('PREVIEW_HELPER_SCRIPT — edição inline de texto (V5-P1B)', () => {
  const EDITOR_HTML = '<div id="text-headline-1">Old</div><img id="img-hero" src="a.jpg" />';

  function findAction(messages: unknown[], action: string) {
    return messages.find((m) => (m as { action?: string }).action === action) as
      | { action: string; elementId?: string; text?: string }
      | undefined;
  }

  function countAction(messages: unknown[], action: string) {
    return messages.filter((m) => (m as { action?: string }).action === action).length;
  }

  it("dblclick em texto entra em modo edit: contenteditable + edit-start", () => {
    const h = bootHelper(EDITOR_HTML);
    const el = h.document.querySelector('#text-headline-1');
    h.dblclick(el);

    const start = findAction(h.parentMessages, 'edit-start');
    expect(start).toMatchObject({ action: 'edit-start', elementId: 'text-headline-1' });
    expect(el!.getAttribute('contenteditable')).toBe('true');
  });

  it('dblclick em imagem NÃO entra em modo edit', () => {
    const h = bootHelper(EDITOR_HTML);
    h.dblclick(h.document.querySelector('#img-hero'));

    expect(findAction(h.parentMessages, 'edit-start')).toBeUndefined();
    expect(h.document.querySelector('#img-hero')!.getAttribute('contenteditable')).toBeNull();
  });

  it('input é debounciado 300ms e coalesce para UM text-input', () => {
    const h = bootHelper(EDITOR_HTML);
    const el = h.document.querySelector('#text-headline-1');
    h.dblclick(el);

    el!.textContent = 'Hello';
    fireElementEvent(h, el, 'input');
    el!.textContent = 'Hello World';
    fireElementEvent(h, el, 'input');

    // Antes do debounce drenar: nada publicado.
    expect(findAction(h.parentMessages, 'text-input')).toBeUndefined();

    h.runTimers();
    expect(countAction(h.parentMessages, 'text-input')).toBe(1);
    const input = findAction(h.parentMessages, 'text-input')!;
    expect(input.elementId).toBe('text-headline-1');
    expect(input.text).toBe('Hello World');
  });

  it('blur commita imediatamente (edit-end) e drena o debounce pendente', () => {
    const h = bootHelper(EDITOR_HTML);
    const el = h.document.querySelector('#text-headline-1');
    h.dblclick(el);

    el!.textContent = 'Typed';
    fireElementEvent(h, el, 'input');
    fireElementEvent(h, el, 'blur');

    const end = findAction(h.parentMessages, 'edit-end');
    expect(end).toMatchObject({ action: 'edit-end', elementId: 'text-headline-1', text: 'Typed' });
    expect(el!.getAttribute('contenteditable')).toBeNull();

    // O debounce pendente foi drenado pelo commit — sem mensagens tardias.
    const total = h.parentMessages.length;
    h.runTimers();
    expect(h.parentMessages.length).toBe(total);
  });

  it('Enter commita com preventDefault (sem <div>/<br> no conteúdo)', () => {
    const h = bootHelper(EDITOR_HTML);
    const el = h.document.querySelector('#text-headline-1');
    h.dblclick(el);

    const res = fireElementEvent(h, el, 'keydown', { key: 'Enter' });

    expect(res.defaultPrevented).toBe(true);
    expect(countAction(h.parentMessages, 'edit-end')).toBe(1);
    expect(el!.getAttribute('contenteditable')).toBeNull();
  });

  it('Esc restaura o texto original antes do commit', () => {
    const h = bootHelper(EDITOR_HTML);
    const el = h.document.querySelector('#text-headline-1');
    h.dblclick(el);

    el!.textContent = 'Changed';
    fireElementEvent(h, el, 'input');
    h.runTimers(); // publica o text-input intermédio
    fireElementEvent(h, el, 'keydown', { key: 'Escape' });

    // DOM restaurado E o pai recebe o texto restaurado no edit-end.
    expect(el!.textContent).toBe('Old');
    const end = findAction(h.parentMessages, 'edit-end')!;
    expect(end.text).toBe('Old');
    expect(el!.getAttribute('contenteditable')).toBeNull();
  });

  it('eco de patch text com valor igual ao editor ativo não reescreve o nó; valor diferente aplica', () => {
    const h = bootHelper(EDITOR_HTML);
    const el = h.document.querySelector('#text-headline-1');
    h.dblclick(el);

    // Eco: o pai devolve exatamente o que o iframe acabou de reportar.
    h.message({
      action: 'patch',
      patches: [{ selector: '#text-headline-1', property: 'text', value: 'Old' }],
    });
    expect(el!.textContent).toBe('Old');
    expect(el!.getAttribute('contenteditable')).toBe('true'); // sessão intacta

    // Valor diferente (ex.: undo) aplica-se mesmo durante a edição.
    h.message({
      action: 'patch',
      patches: [{ selector: '#text-headline-1', property: 'text', value: 'Rewritten' }],
    });
    expect(el!.textContent).toBe('Rewritten');
  });

  it('dblclick noutro elemento durante edição commita o editor anterior', () => {
    const h = bootHelper(
      '<div id="text-a">A</div><div id="text-b">B</div>',
    );
    const a = h.document.querySelector('#text-a');
    const b = h.document.querySelector('#text-b');
    h.dblclick(a);
    h.dblclick(b);

    const endIdx = h.parentMessages.findIndex((m) => (m as { action?: string }).action === 'edit-end');
    const startBIdx = h.parentMessages.findIndex(
      (m) => (m as { action?: string }).action === 'edit-start' && (m as { elementId?: string }).elementId === 'text-b',
    );
    expect(endIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeLessThan(startBIdx);
    expect(a!.getAttribute('contenteditable')).toBeNull();
    expect(b!.getAttribute('contenteditable')).toBe('true');
  });
});

describe('PREVIEW_HELPER_SCRIPT — swap de imagem (V5-P1C)', () => {
  function findAction(messages: unknown[], action: string) {
    return messages.find((m) => (m as { action?: string }).action === action);
  }

  const SWAP_HTML = '<div id="text-title-1">T</div><img id="img-hero" src="assets/vp-media-x.jpg" />';

  it("envelope select transporta o atributo src de elementos media", () => {
    const h = bootHelper(SWAP_HTML);

    h.click(h.document.querySelector('#img-hero'));
    const sel = findAction(h.parentMessages, 'select') as {
      elementId?: string;
      src?: string;
    };
    expect(sel).toMatchObject({ elementId: 'img-hero', src: 'assets/vp-media-x.jpg' });

    // Elemento sem src → envelope SEM a chave (não polui o contrato).
    h.click(h.document.querySelector('#text-title-1'));
    const selText = [...h.parentMessages].reverse().find(
      (m) => (m as { action?: string }).action === 'select',
    ) as { elementId?: string; src?: string };
    expect(selText.elementId).toBe('text-title-1');
    expect('src' in selText).toBe(false);
  });

  it('element-at-point responde com id/tipo/bbox do elemento sob o ponto', () => {
    const h = bootHelper(SWAP_HTML);
    const el = h.document.querySelector('#img-hero');
    (h.document as unknown as Record<string, unknown>).elementFromPoint = () => el;

    h.message({ action: 'element-at-point', x: 12, y: 34 });

    const reply = findAction(h.parentMessages, 'element-at-point') as {
      source?: string;
      elementId?: string | null;
      elementType?: string;
      bbox?: unknown;
      src?: string;
    };
    expect(reply).toMatchObject({
      source: 'hf-preview',
      action: 'element-at-point',
      elementId: 'img-hero',
      elementType: 'image',
      src: 'assets/vp-media-x.jpg',
    });
    expect(reply.bbox).toEqual({ x: 0, y: 0, w: 0, h: 0 }); // linkedom sem layout
  });

  it('element-at-point fora de elemento responde elementId null', () => {
    const h = bootHelper(SWAP_HTML);
    (h.document as unknown as Record<string, unknown>).elementFromPoint = () => null;

    h.message({ action: 'element-at-point', x: 5000, y: 5000 });

    expect(findAction(h.parentMessages, 'element-at-point')).toEqual({
      source: 'hf-preview',
      action: 'element-at-point',
      elementId: null,
    });
  });

  it('element-at-point em ambiente sem layout (sem elementFromPoint) responde null', () => {
    const h = bootHelper(SWAP_HTML);

    h.message({ action: 'element-at-point', x: 1, y: 2 });

    expect(findAction(h.parentMessages, 'element-at-point')).toMatchObject({
      elementId: null,
    });
  });

  it('mensagens inválidas para element-at-point são ignoradas', () => {
    const h = bootHelper(SWAP_HTML);
    (h.document as unknown as Record<string, unknown>).elementFromPoint = () => null;

    h.message({ action: 'element-at-point' }); // sem x/y
    h.message({ action: 'element-at-point', x: '12', y: 3 }); // x não numérico

    expect(findAction(h.parentMessages, 'element-at-point')).toBeUndefined();
  });
});

describe('injectPreviewRuntime — unit (V4_04A fix)', () => {
  it('injeta o runtime logo após <head>', () => {
    const out = injectPreviewRuntime(COMPOSITION_HTML, '/preview/p1/__vp_runtime.js');
    expect(out).toContain(`script ${RUNTIME_SCRIPT_MARKER} src="/preview/p1/__vp_runtime.js"`);
    const headOpen = html_headEnd(COMPOSITION_HTML);
    expect(out.indexOf(RUNTIME_SCRIPT_MARKER)).toBe(headOpen + '<script '.length);
  });

  it('é idempotente (não duplica a tag de runtime)', () => {
    const once = injectPreviewRuntime(COMPOSITION_HTML, '/x.js');
    const twice = injectPreviewRuntime(once, '/x.js');
    expect(twice).toBe(once);
  });

  it('aceita HTML sem <head> (usa </body>) e sem <body> (prefixa)', () => {
    const withBody = injectPreviewRuntime('<body><div>sem head</div></body>', '/x.js');
    expect(withBody.indexOf(RUNTIME_SCRIPT_MARKER)).toBeLessThan(withBody.search(/<\/body>/i));
    const bare = injectPreviewRuntime('<div>nada</div>', '/x.js');
    expect(bare.startsWith(`<script ${RUNTIME_SCRIPT_MARKER}`)).toBe(true);
  });

  it('devolve input inválido sem alterações', () => {
    expect(injectPreviewRuntime('', '/x.js')).toBe('');
    expect(injectPreviewRuntime(null as unknown as string, '/x.js')).toBe(null);
    expect(injectPreviewRuntime(COMPOSITION_HTML, '')).toBe(COMPOSITION_HTML);
  });
});

function html_headEnd(html: string): number {
  const m = html.match(/<head[^>]*>/i);
  return m ? m.index! + m[0].length : -1;
}

describe('GET /preview/:id — injeção sobre HTTP', () => {
  it('serve o index.html com o helper injetado (mode preview)', async () => {
    const res = await post('/job', {
      job_id: 'job-preview-inject',
      project_id: 'proj-inject-1',
      mode: 'preview',
      step: 'build',
      index_html: COMPOSITION_HTML,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ job_id: 'job-preview-inject' });

    const preview = await fetch(`${base}/preview/proj-inject-1`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain(`id="${HELPER_SCRIPT_ID}"`);
    // V4_04A fix: the vendored runtime is injected so the hf-preview bridge
    // boots and answers the editor handshake.
    expect(html).toContain(RUNTIME_SCRIPT_MARKER);
    expect(html).toContain('src="/preview/proj-inject-1/__vp_runtime.js"');
    expect(html).toContain('data-composition-id="main"');
    expect(html.indexOf(HELPER_SCRIPT_ID)).toBeLessThan(html.search(/<\/body>/i));
    expect(preview.headers.get('content-type')).toContain('html');
  });

  it('serve o bundle de runtime em /preview/:id/__vp_runtime.js', async () => {
    const runtime = await fetch(`${base}/preview/proj-inject-1/__vp_runtime.js`);
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get('content-type')).toContain('javascript');
    const body = await runtime.text();
    // The real hyperframe.runtime.iife.js is a large minified bundle.
    expect(body.length).toBeGreaterThan(10_000);
    // It must be the bridge-capable build (posts hf-preview envelopes).
    expect(body).toContain('hf-preview');
  });

  it('lookup por job_id também funciona', async () => {
    const res = await post('/job', {
      job_id: 'job-preview-byjob',
      project_id: 'proj-inject-2',
      mode: 'preview',
      index_html: COMPOSITION_HTML,
    });
    expect(res.status).toBe(200);
    const preview = await fetch(`${base}/preview/job-preview-byjob`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain(`id="${HELPER_SCRIPT_ID}"`);
  });

  it('404 para projeto inexistente', async () => {
    const res = await fetch(`${base}/preview/nao-existe`);
    expect(res.status).toBe(404);
  });

  // V4-3f.9: base tag injection for correct relative URL resolution
  it('injeta <base> tag com href correto para resolver assets relativos', async () => {
    const res = await post('/job', {
      job_id: 'job-base-tag',
      project_id: 'proj-base-tag',
      mode: 'preview',
      index_html: COMPOSITION_HTML,
    });
    expect(res.status).toBe(200);

    const preview = await fetch(`${base}/preview/proj-base-tag`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    // Base tag must appear inside <head>, before the helper script.
    expect(html).toContain('<base href="/preview/proj-base-tag/">');
    const headOpen = html.search(/<head[^>]*>/i);
    const baseIdx = html.indexOf('<base href="/preview/proj-base-tag/">');
    const helperIdx = html.indexOf(`id="${HELPER_SCRIPT_ID}"`);
    expect(baseIdx).toBeGreaterThan(headOpen);
    expect(baseIdx).toBeLessThan(helperIdx);
    // V4-3f.13: o GSAP passou a ser embutido como data URI (já não depende do
    // base tag); os restantes assets locais (imagens/fontes em assets/) continuam
    // relativos e dependem do <base> para resolver sob /preview/<id>/.
    // V4-3f.14: o src carrega name=gsap.min.js para a regra missing_gsap_script.
    expect(html).toContain('data-vp-vendored="gsap"');
    expect(html).toContain('src="data:text/javascript;name=gsap.min.js;base64,');
  });
});

describe('GET /preview/:id/assets/:file — subresources (V4-3f.9 follow-up)', () => {
  // Regression: the preview URL carries the project_id, but the asset route
  // only looked up by internal job_id → every asset 404'd
  // (net::ERR_ABORTED 404 on __vp_gsap.min.js in the Studio editor).
  it('serve o asset vendored GSAP por project_id', async () => {
    const res = await post('/job', {
      job_id: 'job-asset-proj',
      project_id: 'proj-asset-1',
      mode: 'preview',
      index_html: COMPOSITION_HTML,
    });
    expect(res.status).toBe(200);

    const asset = await fetch(`${base}/preview/proj-asset-1/assets/__vp_gsap.min.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    const body = await asset.text();
    expect(body.length).toBeGreaterThan(1000);
  });

  it('lookup por job_id também funciona', async () => {
    const res = await post('/job', {
      job_id: 'job-asset-byjob',
      project_id: 'proj-asset-2',
      mode: 'preview',
      index_html: COMPOSITION_HTML,
    });
    expect(res.status).toBe(200);
    const asset = await fetch(`${base}/preview/job-asset-byjob/assets/__vp_gsap.min.js`);
    expect(asset.status).toBe(200);
  });

  it('serve assets enviados no POST /job', async () => {
    const res = await post('/job', {
      job_id: 'job-asset-custom',
      project_id: 'proj-asset-3',
      mode: 'preview',
      index_html: COMPOSITION_HTML,
      assets: { 'hello.txt': Buffer.from('vp-asset-ok').toString('base64') },
    });
    expect(res.status).toBe(200);
    const asset = await fetch(`${base}/preview/proj-asset-3/assets/hello.txt`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('vp-asset-ok');
  });

  it('404 para projeto inexistente', async () => {
    const res = await fetch(`${base}/preview/nao-existe/assets/__vp_gsap.min.js`);
    expect(res.status).toBe(404);
  });

  it('404 para asset inexistente de projeto válido', async () => {
    const res = await fetch(`${base}/preview/proj-asset-1/assets/nao-existe.png`);
    expect(res.status).toBe(404);
  });

  it('rejeita segmentos com traversal codificado', async () => {
    const res = await fetch(`${base}/preview/proj-asset-1/assets/..%2Findex.html`);
    expect(res.status).toBe(404);
  });
});

describe('GET /preview/:id — enforcement do token HMAC (V4-3g.5, R5)', () => {
  const SECRET = 'test-preview-secret';
  const PROJECT = 'proj-token-guard';

  // The server reads PREVIEW_SECRET once at module load — boot a fresh
  // instance per scenario via resetModules + dynamic import.
  let booted: { srv: http.Server; base: string } | null = null;

  async function bootWorker(secret?: string) {
    vi.resetModules();
    if (secret === undefined) delete process.env.PREVIEW_SECRET;
    else process.env.PREVIEW_SECRET = secret;
    const mod = (await import('./server.js')) as unknown as {
      app: { listen: (port: number, host: string) => http.Server };
    };
    const srv = mod.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    return { srv, base: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
  }

  async function stage(b: string) {
    const res = await fetch(`${b}/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'job-token-guard',
        project_id: PROJECT,
        mode: 'preview',
        index_html: COMPOSITION_HTML,
      }),
    });
    expect(res.status).toBe(200);
  }

  afterEach(async () => {
    if (booted) await new Promise((r) => booted!.srv.close(r));
    booted = null;
    delete process.env.PREVIEW_SECRET;
    vi.resetModules();
  });

  it('401 { error: invalid_token } sem token quando PREVIEW_SECRET está definido', async () => {
    booted = await bootWorker(SECRET);
    await stage(booted.base);
    const res = await fetch(`${booted.base}/preview/${PROJECT}`);
    // 401 (não 404) para o polling do Studio distinguir "não autorizado" de
    // "ainda não staged".
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('401 com token expirado', async () => {
    booted = await bootWorker(SECRET);
    await stage(booted.base);
    const expired = createPreviewToken(PROJECT, SECRET, { now: Date.now() - 60_000, ttlMs: 1000 });
    const res = await fetch(`${booted.base}/preview/${PROJECT}?token=${expired}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('401 com assinatura adulterada', async () => {
    booted = await bootWorker(SECRET);
    await stage(booted.base);
    const tampered = createPreviewToken(PROJECT, 'outro-secret');
    const res = await fetch(`${booted.base}/preview/${PROJECT}?token=${tampered}`);
    expect(res.status).toBe(401);
  });

  it('200 com token válido (staging prévio)', async () => {
    booted = await bootWorker(SECRET);
    await stage(booted.base);
    const token = createPreviewToken(PROJECT, SECRET);
    const res = await fetch(`${booted.base}/preview/${PROJECT}?token=${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`id="${HELPER_SCRIPT_ID}"`);
  });

  it('200 sem token quando PREVIEW_SECRET NÃO está definido (comportamento legacy)', async () => {
    booted = await bootWorker(undefined);
    await stage(booted.base);
    const res = await fetch(`${booted.base}/preview/${PROJECT}`);
    expect(res.status).toBe(200);
  });
});
