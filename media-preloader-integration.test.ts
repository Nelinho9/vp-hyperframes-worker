// @vitest-environment node
/**
 * media-preloader-integration.test.ts — V4-3f.12
 *
 * Integration test: POST /job rejects external media that is not a direct MP4
 * before the HyperFrames render pipeline runs. A local HTTP server acts as the
 * CDN returning an HTML player page; the worker must surface MEDIA_VALIDATION_FAILED.
 *
 * The success path (valid MP4 + ffprobe) is covered by the unit tests in
 * media-preloader.test.ts where spawn can be injected; at the HTTP boundary the
 * worker uses the real ffprobe binary, so we only assert the failure gate here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { app } from './server.js';

let server: http.Server;
let base: string;
let cdnServer: http.Server;
let cdnBase: string;

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

  cdnServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html>player page</html>');
  });
  await new Promise<void>((r) => cdnServer.listen(0, '127.0.0.1', () => r()));
  cdnBase = `http://127.0.0.1:${(cdnServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => cdnServer.close(r));
});

describe('POST /job — media pre-staging', () => {
  it('rejeita job quando a URL de vídeo retorna HTML em vez de MP4', async () => {
    const res = await post('/job', {
      job_id: 'job-media-html',
      project_id: 'proj-media-html',
      step: 'finalize',
      mode: 'preview',
      index_html: `<!doctype html>
        <html><body>
        <div class="composition" data-composition-id="main" data-start="0" data-duration="5" data-width="1080" data-height="1920">
          <video id="video-1" class="clip" src="${cdnBase}/player.html" data-start="0" data-duration="5" muted></video>
        </div>
        </body></html>`,
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.status).toBe('failed');
    expect(body.error).toBe('MEDIA_VALIDATION_FAILED');
    expect(body.failures[0].reason).toBe('not_mp4');
  });
});
