// @vitest-environment node
/**
 * C03 remediation (09/11/2026) — worker egress and resource-graph regressions.
 *
 * Covers AUD-B02 (DNS→socket pinning), AUD-B03 (real attribute parsing +
 * full resource inventory + deny-by-default), AUD-I21 (IPv6 classes),
 * ADJ-01/02 (trusted control-plane vs media, test-loopback flag), ADJ-03
 * (aggregate budget) and ADJ-04 (composition-ref buffer contract).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchBounded,
  isNonPublicIp,
  validateEgressUrl,
} from './bounded-fetch.js';
import {
  assertNoRemoteResources,
  extractMediaUrls,
  hardenCompositionNetwork,
  prestageExternalMedia,
} from './media-preloader.js';
import { fetchCompositionRef } from './server.js';

function minimalPngBuffer() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 0x00),
  ]);
}

function makeResponse(body, opts = {}) {
  const status = opts.status ?? 200;
  const headers = new Map([['content-type', opts.contentType ?? 'image/png']]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers,
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(body) };
          },
          cancel: async () => {},
          releaseLock: () => {},
        };
      },
    },
  };
}

function makeFetchImpl(body) {
  return vi.fn().mockResolvedValue(makeResponse(body));
}

describe('AUD-B02 — DNS validation is pinned to the socket', () => {
  it('connects to the validated address instead of re-resolving the hostname', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`host=${req.headers.host}`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const lookupImpl = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      const { buffer } = await fetchBounded(`http://pinned-c03.invalid:${port}/probe`, {
        lookupImpl,
        disallowLoopback: false,
        timeoutMs: 5_000,
      });
      expect(buffer.toString()).toBe(`host=pinned-c03.invalid:${port}`);
      // One resolution for validation; the socket uses that answer, never a second lookup.
      expect(lookupImpl).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('aborts on the global deadline even while DNS is still pending', async () => {
    const lookupImpl = vi.fn().mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await expect(
      fetchBounded('https://slow-dns-c03.invalid/probe', {
        lookupImpl,
        timeoutMs: 80,
      }),
    ).rejects.toThrow('DOWNLOAD_DEADLINE');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('AUD-B03 — real attribute parsing and full resource inventory', () => {
  it('does not treat data-src as src and rejects the real private src', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-c03-attrs-'));
    const fetchImpl = vi.fn();
    const res = await prestageExternalMedia(
      '<img data-src="https://cdn.example.com/public.png" src="http://169.254.169.254/secret.png">',
      dir,
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failures.some((failure) => failure.reason === 'ssrf_blocked')).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('inventories srcset, poster, source and picture candidates', () => {
    const html = [
      '<img srcset="https://cdn.example.com/a.png 1x, https://cdn.example.com/b.png 2x">',
      '<video poster="https://cdn.example.com/p.jpg" src="https://cdn.example.com/v.mp4">',
      '<picture><source srcset="https://cdn.example.com/c.webp 800w" type="image/webp"><img src="https://cdn.example.com/d.png"></picture>',
    ].join('');
    const urls = extractMediaUrls(html).map((entry) => entry.originalSrc);
    expect(urls).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
      'https://cdn.example.com/p.jpg',
      'https://cdn.example.com/v.mp4',
      'https://cdn.example.com/c.webp',
      'https://cdn.example.com/d.png',
    ]);
  });

  it('stages and rewrites srcset candidates and video poster', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-c03-srcset-'));
    const png = minimalPngBuffer();
    const html = [
      '<img srcset="https://cdn.example.com/a.png 1x, https://cdn.example.com/b.png 2x">',
      '<video poster="https://cdn.example.com/p.jpg"></video>',
    ].join('');
    const fetchImpl = makeFetchImpl(png);
    const result = await prestageExternalMedia(html, dir, { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toMatch(/https:\/\/cdn\.example\.com/);
    expect(result.html).toMatch(/assets\/vp-media-[a-f0-9]+\.png 1x, assets\/vp-media-[a-f0-9]+\.png 2x/);
    expect(result.html).toMatch(/poster="assets\/vp-media-[a-f0-9]+\.png"/);
  });

  it('denies remaining network resources outside the local serving origin', () => {
    expect(() =>
      assertNoRemoteResources('<script src="https://evil.example/x.js"></script>'),
    ).toThrow(/UNSTAGED_REMOTE_RESOURCE/);
    expect(() =>
      assertNoRemoteResources('<style>.a{background:url(https://evil.example/a.png)}</style>'),
    ).toThrow(/UNSTAGED_REMOTE_RESOURCE/);
    expect(() =>
      assertNoRemoteResources('<iframe src="https://evil.example/frame"></iframe>'),
    ).toThrow(/UNSTAGED_REMOTE_RESOURCE/);
    expect(() =>
      assertNoRemoteResources(
        '<img src="assets/vp-media-x.png"><img src="data:image/png;base64,AA"><div style="background:url(assets/x.png)"></div>',
      ),
    ).not.toThrow();
  });

  it('injects a deny-by-default CSP into the composition', () => {
    const hardened = hardenCompositionNetwork('<html><head><title>x</title></head><body></body></html>');
    expect(hardened).toContain('Content-Security-Policy');
    expect(hardened).toContain("connect-src 'self' data: blob:");
    expect(hardened).toContain("default-src 'none'");
    expect(hardened).toContain("img-src 'self' data: blob:");
  });
});

describe('AUD-I21 — IPv6 special-purpose ranges', () => {
  it.each([
    'fec0::1',
    '2001:2::1',
    '64:ff9b::1.2.3.4',
    '100::1',
    '2002:7f00:1::',
    '2001:10::1',
  ])('classifies %s as non-public', (address) => {
    expect(isNonPublicIp(address)).toBe(true);
  });

  it('keeps a global unicast address public', () => {
    expect(isNonPublicIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('ADJ-01/02 — explicit policies and test-flag isolation', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.VP_ALLOW_TEST_LOOPBACK = originalEnv.VP_ALLOW_TEST_LOOPBACK;
  });

  it('ignores VP_ALLOW_TEST_LOOPBACK in production and rejects loopback media', async () => {
    process.env.NODE_ENV = 'production';
    process.env.VP_ALLOW_TEST_LOOPBACK = '1';
    await expect(fetchBounded('http://127.0.0.1:9/media.png')).rejects.toThrow(/SSRF/);
  });

  it('requires an allowlisted origin for control-plane targets', async () => {
    await expect(
      fetchBounded('https://control.example.com/callback', {
        policy: 'control-plane',
        trustedOrigins: ['https://other.example.com'],
      }),
    ).rejects.toThrow('UNTRUSTED_CONTROL_PLANE_ORIGIN');
  });

  it('accepts an allowlisted control-plane origin', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const { buffer } = await fetchBounded(`http://127.0.0.1:${port}/callback`, {
        policy: 'control-plane',
        trustedOrigins: [`http://127.0.0.1:${port}`],
      });
      expect(buffer.toString()).toBe('ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('ADJ-03 — aggregate media budget', () => {
  it('fails the job when the aggregate byte budget is exceeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-c03-budget-'));
    const png = minimalPngBuffer();
    const fetchImpl = makeFetchImpl(png);
    const result = await prestageExternalMedia(
      '<img src="https://cdn.example.com/1.png"><img src="https://cdn.example.com/2.png">',
      dir,
      { fetchImpl, maxTotalBytes: png.length + 8 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MEDIA_BUDGET_EXCEEDED');
  });
});

describe('ADJ-04 — composition reference transport', () => {
  it('returns the downloaded HTML from the bounded transport buffer', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body>from-ref</body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const previousOrigins = process.env.WORKER_CONTROL_PLANE_ORIGINS;
    process.env.WORKER_CONTROL_PLANE_ORIGINS = `http://127.0.0.1:${port}`;
    try {
      const html = await fetchCompositionRef(`http://127.0.0.1:${port}/composition.html`);
      expect(html).toContain('from-ref');
    } finally {
      if (previousOrigins === undefined) delete process.env.WORKER_CONTROL_PLANE_ORIGINS;
      else process.env.WORKER_CONTROL_PLANE_ORIGINS = previousOrigins;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('validateEgressUrl — HTTPS policy', () => {
  it('rejects http when requireHttps is set', async () => {
    await expect(
      validateEgressUrl('http://example.com/x', { requireHttps: true }),
    ).rejects.toThrow('SSRF_PROTOCOL_BLOCKED');
  });
});