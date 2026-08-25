// @vitest-environment node
/**
 * thumbnails.test.ts — V5-P2D (master plan §7.3): per-scene timeline
 * thumbnails captured ONCE per artifact by the vendored hyperframes CLI
 * (`snapshot --at t1,t2 --no-end --describe false`) and served from
 * `{jobDir}/thumbs/`, cached by sha1(index.html).
 *
 * Covers:
 * 1. computeArtifactHash — stable per content, distinct across contents.
 * 2. parseSceneMidpoints — ROOT-owned .clip windows only (patch-engine
 *    convention), midpoint quantized to ms, nested compositions ignored.
 * 3. buildSnapshotCommandArgs — canonical CLI invocation (HYPERFRAMES_BIN
 *    override respected).
 * 4. captureThumbnails — fast path via cached manifest; fresh capture runs
 *    the injected runner and persists the manifest; CLI failure throws an
 *    honest error; no scenes → no CLI call; concurrent calls dedup to ONE run.
 * 5. HTTP routes — GET /preview/:id/thumbnails (HMAC-gated like the preview)
 *    and GET /preview/:id/thumbs/:file (basename-guarded static PNG).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSnapshotCommandArgs,
  captureThumbnails,
  computeArtifactHash,
  parseSceneMidpoints,
} from './thumbnails.js';

const HTML = `<!doctype html><html><body>
<div class="composition" data-composition-id="main" data-start="0" data-duration="10">
  <div id="scene-1" class="clip" data-start="0" data-duration="3" data-track-index="0"></div>
  <div id="deco" class="overlay" data-start="0" data-duration="3"></div>
  <div id="scene-2" class="clip" data-start="3" data-duration="2.5" data-track-index="0">
    <div class="composition" data-composition-id="nested" data-start="0" data-duration="99">
      <div id="inner" class="clip" data-start="77" data-duration="3"></div>
    </div>
  </div>
  <div id="scene-3" class="clip" data-start="5.5" data-duration="0.006" data-track-index="0"></div>
</div>
</body></html>`;

function makeRun(filesByCall: Array<string[]>, code = 0) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = async (command: string, args: string[], _opts?: unknown) => {
    calls.push({ command, args });
    const outIdx = args.indexOf('-o');
    const outDir = outIdx >= 0 ? args[outIdx + 1] : '';
    mkdirSync(outDir, { recursive: true });
    for (const f of filesByCall[Math.min(calls.length - 1, filesByCall.length - 1)] ?? []) {
      writeFileSync(join(outDir, f), 'png-bytes');
    }
    return { code, signal: null, stdout: '', stderr: code === 0 ? '' : 'cli exploded' };
  };
  return { run, calls };
}

describe('computeArtifactHash', () => {
  it('é estável para o mesmo conteúdo e distinto entre conteúdos', () => {
    expect(computeArtifactHash(HTML)).toBe(computeArtifactHash(HTML));
    expect(computeArtifactHash(HTML)).not.toBe(computeArtifactHash(HTML + '<!-- x -->'));
    expect(computeArtifactHash(HTML)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('parseSceneMidpoints', () => {
  it('devolve o ponto médio das janelas dos clips RAIZ, ordenado', () => {
    // scene-1: 0+3/2 = 1.5 · scene-2: 3+2.5/2 = 4.25 · scene-3: 5.503 → quantizado
    expect(parseSceneMidpoints(HTML)).toEqual([1.5, 4.25, 5.503]);
  });

  it('html sem clips raiz devolve []', () => {
    expect(parseSceneMidpoints('<html><body><p>oi</p></body></html>')).toEqual([]);
  });

  it('clips sem duração utilizável são ignorados', () => {
    const html =
      '<div data-composition-id="m">' +
      '<div id="a" class="clip" data-start="0"></div>' +
      '<div id="b" class="clip" data-start="1" data-duration="2"></div>' +
      '</div>';
    expect(parseSceneMidpoints(html)).toEqual([2]);
  });
});

describe('buildSnapshotCommandArgs', () => {
  it('args canónicos: --at joined, --no-end, --describe false, -o, projeto', () => {
    const { command, args } = buildSnapshotCommandArgs([1.5, 4.25], '/job/thumbs', '/job');
    expect(command).toBe('npx');
    expect(args).toEqual([
      'hyperframes', 'snapshot',
      '--at', '1.5,4.25',
      '--no-end',
      '--describe', 'false',
      '-o', '/job/thumbs',
      '/job',
    ]);
  });

  it('HYPERFRAMES_BIN substitui npx hyperframes', () => {
    process.env.HYPERFRAMES_BIN = '/usr/local/bin/hyperframes';
    try {
      const { command, args } = buildSnapshotCommandArgs([2], '/o', '/p');
      expect(command).toBe('/usr/local/bin/hyperframes');
      expect(args[0]).toBe('snapshot');
    } finally {
      delete process.env.HYPERFRAMES_BIN;
    }
  });
});

describe('captureThumbnails', () => {
  let jobDir: string;
  beforeAll(() => {
    jobDir = mkdtempSync(join(tmpdir(), 'worker-thumbs-'));
    writeFileSync(join(jobDir, 'index.html'), HTML);
  });
  afterAll(() => rmSync(jobDir, { recursive: true, force: true }));

  it('captura nova: corre o CLI, grava manifest e mapeia os PNGs gerados', async () => {
    const { run, calls } = makeRun([['frame-00-at-1.5s.png', 'frame-01-at-4.25s.png']]);
    const res = await captureThumbnails({ jobDir, html: HTML, run });
    expect(res.cached).toBe(false);
    expect(calls).toHaveLength(1);
    expect(res.artifact).toBe(computeArtifactHash(HTML));
    expect(res.items).toEqual([
      { time_s: 1.5, file: 'frame-00-at-1.5s.png' },
      { time_s: 4.25, file: 'frame-01-at-4.25s.png' },
    ]);
    const manifestPath = join(jobDir, 'thumbs', `manifest-${res.artifact}.json`);
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.items).toHaveLength(2);
    expect(manifest.fps).toBe(30);
  });

  it('fast path: manifest existente devolve cache SEM correr o CLI', async () => {
    const { run, calls } = makeRun([]);
    const first = await captureThumbnails({ jobDir, html: HTML, run });
    const second = await captureThumbnails({ jobDir, html: HTML, run });
    expect(second.cached).toBe(true);
    expect(second.artifact).toBe(first.artifact);
    expect(second.items).toEqual(first.items);
    expect(calls).toHaveLength(0);
  });

  it('falha do CLI lança erro honesto com o stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-thumbs-fail-'));
    try {
      const { run } = makeRun([], /* code */ 1);
      await expect(captureThumbnails({ jobDir: dir, html: HTML, run })).rejects.toThrow(/cli exploded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sem cenas não invoca o CLI e devolve items vazio', async () => {
    const { run, calls } = makeRun([]);
    const res = await captureThumbnails({
      jobDir,
      html: '<html><body><p>vazio</p></body></html>',
      run,
    });
    expect(res.items).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('pedidos concorrentes para o mesmo artifact deduplicam num único run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-thumbs-race-'));
    try {
      let calls = 0;
      const run = async (_c: string, a: string[]) => {
        calls += 1;
        const outDir = a[a.indexOf('-o') + 1];
        mkdirSync(outDir, { recursive: true });
        await new Promise((r) => setTimeout(r, 20));
        writeFileSync(join(outDir, 'frame-00-at-1.5s.png'), 'x');
        return { code: 0, signal: null, stdout: '', stderr: '' };
      };
      const [a, b] = await Promise.all([
        captureThumbnails({ jobDir: dir, html: HTML, run }),
        captureThumbnails({ jobDir: dir, html: HTML, run }),
      ]);
      expect(calls).toBe(1);
      expect(a.items).toEqual(b.items);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── HTTP routes ──────────────────────────────────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), 'worker-thumbs-http-'));
const PROJECT = 'proj-thumbs';
const JOB = 'job-thumbs-1';
const jobDir = join(workDir, JOB);
mkdirSync(join(jobDir, 'thumbs'), { recursive: true });
writeFileSync(join(jobDir, 'index.html'), HTML);
writeFileSync(
  join(jobDir, 'job.json'),
  JSON.stringify({ job_id: JOB, project_id: PROJECT, step: 'build', created_at: '2026-08-25T00:00:00.000Z' }),
);
writeFileSync(join(jobDir, 'thumbs', 'frame-00-at-1.5s.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
// Pre-seeded per-artifact manifest → the route short-circuits WITHOUT
// spawning the real CLI (unit tests above already cover the capture path).
writeFileSync(
  join(jobDir, 'thumbs', `manifest-${computeArtifactHash(HTML)}.json`),
  JSON.stringify({
    artifact: computeArtifactHash(HTML),
    generated_at: '2026-08-25T00:00:00.000Z',
    fps: 30,
    items: [{ time_s: 1.5, file: 'frame-00-at-1.5s.png' }],
  }),
);

process.env.WORK_DIR = workDir;
process.env.PREVIEW_SECRET = 'thumbs-test-secret';

const { app } = (await import('./server.js')) as unknown as {
  app: { listen: (port: number, host: string) => http.Server };
};
const { createPreviewToken } = (await import('./preview-token.js')) as {
  createPreviewToken: (projectId: string, secret: string) => string;
};

let server: http.Server;
let base: string;

async function get(path: string): Promise<{ status: number; body: Buffer; json: any }> {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json: any = null;
        try { json = JSON.parse(body.toString('utf-8')); } catch { /* binary */ }
        resolve({ status: res.statusCode ?? 0, body, json });
      });
    }).on('error', reject);
  });
}

describe('GET /preview/:id/thumbnails + /preview/:id/thumbs/:file', () => {
  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('token válido sobre manifest em cache → JSON com artifact/items/urls', async () => {
    const token = createPreviewToken(PROJECT, 'thumbs-test-secret');
    const res = await get(`/preview/${PROJECT}/thumbnails?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.artifact).toBe(computeArtifactHash(HTML));
    expect(res.json.items[0]).toEqual({
      time_s: 1.5,
      file: 'frame-00-at-1.5s.png',
      url: `/preview/${PROJECT}/thumbs/frame-00-at-1.5s.png`,
    });
  });

  it('token inválido → 401 (não revela existência)', async () => {
    const res = await get(`/preview/${PROJECT}/thumbnails?token=bogus`);
    expect(res.status).toBe(401);
  });

  it('projeto desconhecido → 404', async () => {
    const token = createPreviewToken('proj-other', 'thumbs-test-secret');
    const res = await get(`/preview/proj-other/thumbnails?token=${token}`);
    expect(res.status).toBe(404);
  });

  it('serve o PNG do diretório thumbs com content-type imagem', async () => {
    const res = await get(`/preview/${PROJECT}/thumbs/frame-00-at-1.5s.png`);
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('traversal no nome do ficheiro é recusado', async () => {
    const res = await get(`/preview/${PROJECT}/thumbs/%2e%2e%2findex.html`);
    expect([403, 404]).toContain(res.status);
  });
});
