// @vitest-environment node
/**
 * preview-fallback.test.ts — F3 (plano Video-Engine v2, emenda A): cadeia de
 * fallback do preview PRÉ-publicação — head publicado → job local →
 * build-input.html da Storage → placeholder neutro. Qualquer worker pode
 * servir qualquer projeto (o volume local é cache, não estado crítico).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { app, readPreviewBuildInput, PREVIEW_PLACEHOLDER_HTML } from './server.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

let server: http.Server;
let base: string;
const workerApp = app as unknown as { listen: (port: number, host: string) => http.Server };

beforeAll(async () => {
  server = workerApp.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

function fakeStorageClient(opts: { html?: string | null; error?: boolean; throwErr?: boolean }) {
  return {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          if (opts.throwErr) throw new Error('network down');
          if (bucket !== 'video-artifacts') return { data: null, error: { message: 'bad bucket' } };
          if (path !== `projects/${PROJECT_ID}/compositions/build-input.html`) return { data: null, error: { message: 'not found' } };
          if (opts.error || opts.html == null) return { data: null, error: { message: 'not found' } };
          return { data: { text: async () => opts.html }, error: null };
        },
      }),
    },
  };
}

describe('readPreviewBuildInput — fallback de Storage (helper puro)', () => {
  it('lê o build-input.html do projeto quando existe', async () => {
    const html = '<!doctype html><html><body>build</body></html>';
    const out = await readPreviewBuildInput(fakeStorageClient({ html }), PROJECT_ID);
    expect(out).toBe(html);
  });

  it('null sem cliente, com id não-projeto, objeto ausente, vazio ou erro de transporte', async () => {
    expect(await readPreviewBuildInput(null, PROJECT_ID)).toBeNull();
    expect(await readPreviewBuildInput(fakeStorageClient({ html: '<x/>' }), 'not-a-uuid')).toBeNull();
    expect(await readPreviewBuildInput(fakeStorageClient({ html: null }), PROJECT_ID)).toBeNull();
    expect(await readPreviewBuildInput(fakeStorageClient({ html: '   ' }), PROJECT_ID)).toBeNull();
    expect(await readPreviewBuildInput(fakeStorageClient({ error: true }), PROJECT_ID)).toBeNull();
    expect(await readPreviewBuildInput(fakeStorageClient({ throwErr: true }), PROJECT_ID)).toBeNull();
  });
});

describe('GET /preview/:id — cadeia de fallback (sem job local)', () => {
  it('id de projeto desconhecido → placeholder neutro 200 com X-Preview-Source (nunca 404 seco)', async () => {
    // Sem SUPABASE_URL no ambiente de teste → sem cliente Storage → a cadeia
    // cai no placeholder (último recurso), que é o comportamento multi-worker.
    const res = await fetch(`${base}/preview/${PROJECT_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-preview-source')).toBe('placeholder');
    const body = await res.text();
    expect(body).toContain('A preparar o preview');
    expect(body).toContain('http-equiv="refresh"');
    expect(body).toBe(PREVIEW_PLACEHOLDER_HTML);
  });

  it('id legacy (job_id desconhecido) mantém o 404 histórico', async () => {
    const res = await fetch(`${base}/preview/22222222-2222-4222-8222-222222222222`);
    // O id é UUID (formato de projeto) → placeholder; o 404 legacy aplica-se
    // a ids fora do formato de projeto.
    expect(res.status).toBe(200);
    const legacy = await fetch(`${base}/preview/job-legacy-desconhecido`);
    expect(legacy.status).toBe(404);
  });
});