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
    // Patch semantics mirror patchHtml.ts.
    expect(PREVIEW_HELPER_SCRIPT).toContain('textContent');
    expect(PREVIEW_HELPER_SCRIPT).toContain("setAttribute('src'");
    expect(PREVIEW_HELPER_SCRIPT).toContain('background-image');
    expect(PREVIEW_HELPER_SCRIPT).toContain('style.setProperty');
    // Inspector prop → CSS mapping (x→left, y→top) present.
    expect(PREVIEW_HELPER_SCRIPT).toContain('"x":"left"');
    expect(PREVIEW_HELPER_SCRIPT).toContain('"y":"top"');
  });

  it('é JavaScript válido (compila sem executar)', () => {
    // vm.Script only parses/compiles the static helper source — never runs it.
    expect(() => new vm.Script(PREVIEW_HELPER_SCRIPT)).not.toThrow();
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
