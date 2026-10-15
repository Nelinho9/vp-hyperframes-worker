// @vitest-environment node
/**
 * preview-source-identity.test.ts — E01-B C2 R09 live increment.
 *
 * Invariant: the worker MUST attest WHICH canonical source the served preview
 * was staged from (published revision + C5 content hash), so the editor's
 * receipt correlator (publicationSyncRuntime) can prove the iframe's `ready`
 * handshake came from the committed revision — never a bare handshake.
 *
 * This covers the serve path for publication-staged previews (the activation
 * candidate written by `publish()` with publication_revision/content_hash).
 * Legacy job previews (no publication identity) must stay identity-less —
 * served previews never lie about which source they show.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { fixtureFetch as fetch } from './test-http-fixture';
import { app } from './server.js';
import {
  injectPreviewHelper, injectSourceIdentity, parseSourceIdentity, resolveServedSourceIdentity, SOURCE_IDENTITY_MARKER,
} from './preview-helper.js';

const COMPOSITION_HTML = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div data-composition-id="main">
  <h1 id="text-headline-1">Hello</h1>
</div>
</body>
</html>`;

let server: http.Server;
let base: string;

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

describe('injectSourceIdentity — pure injection', () => {
  it('injects a data-vp-source-identity meta with revision and C5 hash', () => {
    const out = injectSourceIdentity(COMPOSITION_HTML, { revision: 7, contentHash: 'a'.repeat(64) });
    expect(out).toContain(SOURCE_IDENTITY_MARKER);
    const parsed = parseSourceIdentity(out);
    expect(parsed).toEqual({ revision: 7, contentHash: 'a'.repeat(64) });
  });

  it('is idempotent (a second injection does not duplicate the marker)', () => {
    const once = injectSourceIdentity(COMPOSITION_HTML, { revision: 7, contentHash: 'b'.repeat(64) });
    const twice = injectSourceIdentity(once, { revision: 8, contentHash: 'c'.repeat(64) });
    expect(twice).toBe(once);
  });

  it('returns html without a marker when identity is absent (never lies)', () => {
    expect(injectSourceIdentity(COMPOSITION_HTML, null)).toBe(COMPOSITION_HTML);
    // parse of a composition without the marker → null (identity-less).
    expect(parseSourceIdentity(COMPOSITION_HTML)).toBeNull();
  });

  it('keeps the identity inside <head> when present', () => {
    const out = injectSourceIdentity(COMPOSITION_HTML, { revision: 3, contentHash: 'd'.repeat(64) });
    const headOpen = out.search(/<head[^>]*>/i);
    const markerIdx = out.indexOf(SOURCE_IDENTITY_MARKER);
    expect(markerIdx).toBeGreaterThan(headOpen);
  });
});

describe('resolveServedSourceIdentity — job record decision (R09)', () => {
  it('prefers the publication activation identity when present', () => {
    expect(resolveServedSourceIdentity({
      publication_revision: 5,
      publication_content_hash: 'a'.repeat(64),
      composition_revision: 3,
      published_content_hash: 'b'.repeat(64),
    })).toEqual({ revision: 5, contentHash: 'a'.repeat(64) });
  });

  it('uses the staged published identity when no activation identity exists', () => {
    expect(resolveServedSourceIdentity({
      composition_revision: 7,
      published_content_hash: 'c'.repeat(64),
    })).toEqual({ revision: 7, contentHash: 'c'.repeat(64) });
  });

  it('returns null for legacy jobs and malformed hashes (fail-closed)', () => {
    expect(resolveServedSourceIdentity(null)).toBeNull();
    expect(resolveServedSourceIdentity({})).toBeNull();
    expect(resolveServedSourceIdentity({ publication_revision: 5, publication_content_hash: 'zz' })).toBeNull();
    expect(resolveServedSourceIdentity({ composition_revision: 7, published_content_hash: 'nothash' })).toBeNull();
    expect(resolveServedSourceIdentity({ composition_revision: 7.5, published_content_hash: 'd'.repeat(64) })).toBeNull();
  });

  it('end-to-end: injection of a resolved activation identity round-trips through parse', () => {
    const identity = resolveServedSourceIdentity({
      publication_revision: 9, publication_content_hash: 'e'.repeat(64),
    });
    const served = injectPreviewHelper(injectSourceIdentity(COMPOSITION_HTML, identity));
    expect(parseSourceIdentity(served)).toEqual(identity);
  });
});

describe('GET /preview/:id — publication identity served (R09)', () => {
  it('a legacy job without publication identity serves NO marker (fail-closed)', async () => {
    const res = await post('/job', {
      job_id: '8d2f3e55-8b21-4c7f-9a32-1b2c3d4e5f6a',
      project_id: '8e3f2d41-5f88-4d2a-8b55-2a1f3e4d5c6b',
      mode: 'preview',
      step: 'build',
      index_html: COMPOSITION_HTML,
    });
    expect([200, 202]).toContain(res.status);

    const preview = await fetch(`${base}/preview/8e3f2d41-5f88-4d2a-8b55-2a1f3e4d5c6b`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    // Identity is read via the parser — the helper script body legitimately
    // mentions the marker name (it reads the meta); no marker ELEMENT exists.
    expect(parseSourceIdentity(html)).toBeNull();
    expect(html).not.toMatch(/<meta[^>]*data-vp-source-identity/);
  });
});
