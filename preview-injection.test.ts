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
    expect(html).toContain('data-composition-id="main"');
    expect(html.indexOf(HELPER_SCRIPT_ID)).toBeLessThan(html.search(/<\/body>/i));
    expect(preview.headers.get('content-type')).toContain('html');
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
