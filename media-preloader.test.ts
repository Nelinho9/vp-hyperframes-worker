// @vitest-environment node
/**
 * media-preloader.test.ts — V4-3f.12
 *
 * Covers the worker's media pre-staging logic: extracting external video/audio
 * URLs from composition HTML, downloading + validating them with ffprobe,
 * rewriting the HTML to use local assets, and surfacing clear errors early.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  extractMediaUrls,
  rewriteHtmlMediaUrls,
  downloadAndValidateMedia,
  downloadAndValidateImage,
  downloadAndValidateAudio,
  prestageExternalMedia,
  sniffAudioKind,
  sniffImageKind,
} from './media-preloader.js';

const VALID_MP4_PREFIX = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]), // box size
  Buffer.from('ftyp', 'ascii'),
  Buffer.from('isom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('isom', 'ascii'),
  Buffer.from('mp41', 'ascii'),
]);

function minimalMp4Buffer() {
  // Enough bytes to pass the magic check; ffprobe is mocked in these tests.
  return Buffer.concat([VALID_MP4_PREFIX, Buffer.alloc(64, 0x00)]);
}

function fakeFfprobeStdout(duration = 12, width = 1920, height = 1080) {
  return JSON.stringify({
    format: { duration: String(duration) },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width,
        height,
      },
    ],
  });
}

function makeResponse(body: Buffer, opts: { status?: number; contentType?: string; contentLength?: string } = {}) {
  const status = opts.status ?? 200;
  const headers = new Map<string, string>([
    ['content-type', opts.contentType ?? 'video/mp4'],
  ]);
  if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    headers: headers as unknown as Headers,
    text: async () => body.toString('utf8'),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(body) };
          },
          releaseLock: () => {},
        };
      },
    },
  } as unknown as Response;
}

function makeFetchImpl(body: Buffer, opts: { status?: number; contentType?: string; contentLength?: string } = {}) {
  return vi.fn().mockResolvedValue(makeResponse(body, opts));
}

function makeSpawnImpl({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  return vi.fn().mockImplementation(() => {
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout: stdoutStream,
      stderr: stderrStream,
    }) as unknown as ChildProcess;
    process.nextTick(() => {
      if (stdout) stdoutStream.write(stdout);
      stdoutStream.end();
      if (stderr) stderrStream.write(stderr);
      stderrStream.end();
      child.emit('close', exitCode);
    });
    return child;
  });
}

function minimalPngBuffer() {
  // PNG magic + enough bytes for sniffing; not decoded anywhere these tests.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 0x00),
  ]);
}

function minimalSvgBuffer() {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    'utf8'
  );
}

describe('extractMediaUrls', () => {
  it('extrai URLs de video e audio absolutas', () => {
    const html = `
      <video id="v1" src="https://cdn.example.com/intro.mp4" muted></video>
      <audio id="a1" src="https://cdn.example.com/music.mp4"></audio>
    `;
    const urls = extractMediaUrls(html);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatchObject({ tag: 'video', originalSrc: 'https://cdn.example.com/intro.mp4' });
    expect(urls[1]).toMatchObject({ tag: 'audio', originalSrc: 'https://cdn.example.com/music.mp4' });
  });

  it('extrai src de <img> como tag image (V4-3f.13)', () => {
    const html = '<img id="img-logo" src="https://cdn.example.com/asset-0" alt="logo">';
    const urls = extractMediaUrls(html);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatchObject({ tag: 'image', originalSrc: 'https://cdn.example.com/asset-0' });
  });

  it('ignora src locais, data URIs e blobs', () => {
    const html = `
      <video src="assets/local.mp4"></video>
      <video src="data:video/mp4;base64,abc"></video>
      <video src="blob:https://x"></video>
      <video src="https://cdn.example.com/remote.mp4"></video>
    `;
    const urls = extractMediaUrls(html);
    expect(urls).toHaveLength(1);
    expect(urls[0].originalSrc).toBe('https://cdn.example.com/remote.mp4');
  });

  it('ignora tags sem src', () => {
    const html = '<video id="no-src"></video>';
    expect(extractMediaUrls(html)).toHaveLength(0);
  });
});

describe('rewriteHtmlMediaUrls', () => {
  it('substitui src externos por caminhos locais preservando atributos', () => {
    const html = '<video id="v1" crossorigin="anonymous" muted playsinline src="https://cdn.example.com/intro.mp4">';
    const out = rewriteHtmlMediaUrls(html, {
      'https://cdn.example.com/intro.mp4': 'assets/vp-media-hash.mp4',
    });
    expect(out).toContain('src="assets/vp-media-hash.mp4"');
    expect(out).toContain('crossorigin="anonymous"');
    expect(out).toContain('muted');
  });

  it('substitui src de <img> preservando atributos (V4-3f.13)', () => {
    const html = '<img id="img-logo" alt="logo" src="https://cdn.example.com/asset-0">';
    const out = rewriteHtmlMediaUrls(html, {
      'https://cdn.example.com/asset-0': 'data:image/svg+xml;base64,QUJD',
    });
    expect(out).toContain('src="data:image/svg+xml;base64,QUJD"');
    expect(out).toContain('alt="logo"');
  });

  it('não altera URLs que não estão no mapeamento', () => {
    const html = '<video src="https://cdn.example.com/keep.mp4">';
    expect(rewriteHtmlMediaUrls(html, {})).toBe(html);
  });
});

describe('sniffImageKind', () => {
  it('reconhece PNG, JPEG, GIF, WebP, SVG e desconhecido', () => {
    expect(sniffImageKind(minimalPngBuffer())).toBe('png');
    expect(sniffImageKind(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]))).toBe('jpeg');
    expect(sniffImageKind(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]))).toBe('gif');
    expect(
      sniffImageKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]))
    ).toBe('webp');
    expect(sniffImageKind(minimalSvgBuffer())).toBe('svg');
    expect(sniffImageKind(Buffer.from('<!doctype html><html>player</html>'))).toBe('unknown');
  });

  it('detecta SVG precedido de declaração XML', () => {
    const svg = Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageKind(svg)).toBe('svg');
  });
});

describe('downloadAndValidateImage', () => {
  it('SVG → devolve data URI base64 e não grava ficheiro', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-img-'));
    const fetchImpl = makeFetchImpl(minimalSvgBuffer(), { contentType: 'image/svg+xml' });
    const result = await downloadAndValidateImage('https://cdn.example.com/asset-0', dir, 'hashsvg', {
      fetchImpl,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('svg');
    expect(result.dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(result.dataUri).toBe(`data:image/svg+xml;base64,${minimalSvgBuffer().toString('base64')}`);
    expect(result.path).toBeUndefined();
  });

  it('PNG → grava ficheiro local com extensão correta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-img-'));
    const fetchImpl = makeFetchImpl(minimalPngBuffer(), { contentType: 'image/png' });
    const result = await downloadAndValidateImage('https://cdn.example.com/asset-2', dir, 'hashpng', {
      fetchImpl,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('png');
    expect(result.assetName).toBe('vp-media-hashpng.png');
    expect(readFileSync(join(dir, 'vp-media-hashpng.png')).length).toBe(minimalPngBuffer().length);
  });

  it('respeita o conteúdo (não o content-type) — JPEG com header PNG', () => {
    // asset-7/asset-8 reais: content-type image/png mas bytes JPEG.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);
    expect(sniffImageKind(jpeg)).toBe('jpeg');
  });

  it('falha com not_image quando o corpo é uma página HTML', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-img-'));
    const fetchImpl = makeFetchImpl(Buffer.from('<!doctype html><html>player page</html>'), {
      contentType: 'text/html',
    });
    const result = await downloadAndValidateImage('https://cdn.example.com/player', dir, 'hashhtml', {
      fetchImpl,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_image');
  });

  it('falha com download_failed em HTTP 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-img-'));
    const fetchImpl = makeFetchImpl(Buffer.from('not found'), { status: 404, contentType: 'text/plain' });
    const result = await downloadAndValidateImage('https://cdn.example.com/missing', dir, 'hash404', {
      fetchImpl,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('download_failed');
    expect(result.detail).toContain('404');
  });
});

describe('downloadAndValidateMedia', () => {
  it('sucesso: descarrega MP4 válido e devolve metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const dest = join(dir, 'valid.mp4');
    const fetchImpl = makeFetchImpl(minimalMp4Buffer(), { contentType: 'video/mp4' });
    const spawnImpl = makeSpawnImpl({ stdout: fakeFfprobeStdout() });

    const result = await downloadAndValidateMedia('https://cdn.example.com/intro.mp4', dest, {
      fetchImpl,
      spawnImpl,
      ffprobePath: '/bin/ffprobe',
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(dest);
    expect(result.duration).toBe(12);
    expect(result.width).toBe(1920);
    expect(result.codec).toBe('h264');
    expect(readFileSync(dest).length).toBeGreaterThan(0);
  });

  it('falha quando o servidor retorna HTML em vez de MP4', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const dest = join(dir, 'fake.mp4');
    const html = Buffer.from('<!doctype html><html>player page</html>', 'utf8');
    const fetchImpl = makeFetchImpl(html, { contentType: 'text/html' });
    const spawnImpl = makeSpawnImpl({ stdout: fakeFfprobeStdout() });

    const result = await downloadAndValidateMedia('https://cdn.example.com/player', dest, {
      fetchImpl,
      spawnImpl,
      ffprobePath: '/bin/ffprobe',
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_mp4');
    expect(result.detail).toContain('MP4 magic');
  });

  it('falha com HTTP 403', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const dest = join(dir, 'forbidden.mp4');
    const fetchImpl = makeFetchImpl(Buffer.from('forbidden'), { status: 403 });
    const spawnImpl = makeSpawnImpl({ stdout: fakeFfprobeStdout() });

    const result = await downloadAndValidateMedia('https://cdn.example.com/private.mp4', dest, {
      fetchImpl,
      spawnImpl,
      ffprobePath: '/bin/ffprobe',
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('download_failed');
    expect(result.detail).toContain('403');
  });

  it('falha quando ffprobe rejeita o container', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const dest = join(dir, 'broken.mp4');
    const fetchImpl = makeFetchImpl(minimalMp4Buffer(), { contentType: 'video/mp4' });
    const spawnImpl = makeSpawnImpl({ exitCode: 1, stderr: 'moov atom not found' });

    const result = await downloadAndValidateMedia('https://cdn.example.com/broken.mp4', dest, {
      fetchImpl,
      spawnImpl,
      ffprobePath: '/bin/ffprobe',
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ffprobe_failed');
    expect(result.detail).toContain('moov atom not found');
  });
});

describe('prestageExternalMedia', () => {
  it('skipped quando não há media externa', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const result = await prestageExternalMedia('<video src="assets/local.mp4"></video>', dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toBe(true);
    expect(result.downloaded).toHaveLength(0);
  });

  it('devolve failure quando uma URL externa falha', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(Buffer.from('not found'), { status: 404, contentType: 'text/plain' })
    );

    const result = await prestageExternalMedia(
      '<video src="https://cdn.example.com/missing.mp4"></video>',
      dir,
      { fetchImpl }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MEDIA_VALIDATION_FAILED');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toBe('download_failed');
  });

  it('devolve html reescrito e downloaded quando todas as URLs são válidas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const url = 'https://cdn.example.com/clip.mp4';
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(minimalMp4Buffer(), { contentType: 'video/mp4' }));
    const spawnImpl = makeSpawnImpl({ stdout: fakeFfprobeStdout() });

    const result = await prestageExternalMedia(
      `<video id="v1" src="${url}" muted></video>`,
      dir,
      { fetchImpl, spawnImpl }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toBe(false);
    expect(result.downloaded).toHaveLength(1);
    expect(result.html).toContain('src="assets/vp-media-');
    expect(result.html).not.toContain(url);
  });

  it('inline SVG em <img> como data URI e remove a URL externa (V4-3f.13)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const url = 'https://cdn.example.com/asset-0';
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(minimalSvgBuffer(), { contentType: 'image/svg+xml' }));

    const result = await prestageExternalMedia(
      `<img id="img-logo" src="${url}" alt="logo">`,
      dir,
      { fetchImpl }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toBe(false);
    expect(result.downloaded).toEqual([url]);
    expect(result.html).toContain('src="data:image/svg+xml;base64,');
    expect(result.html).not.toContain(url);
    expect(result.html).toContain('alt="logo"');
  });

  it('pré-estageia <img> raster com extensão correta (V4-3f.13)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const url = 'https://cdn.example.com/asset-2';
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(minimalPngBuffer(), { contentType: 'image/png' }));

    const result = await prestageExternalMedia(
      `<img id="img-bg" src="${url}" alt="bg">`,
      dir,
      { fetchImpl }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('src="assets/vp-media-');
    expect(result.html).toContain('.png"');
    expect(result.html).not.toContain(url);
  });

  it('falha quando uma <img> externa devolve HTML (V4-3f.13)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(Buffer.from('<!doctype html><html>player</html>'), { status: 200, contentType: 'text/html' })
    );

    const result = await prestageExternalMedia(
      '<img id="img-x" src="https://cdn.example.com/player">',
      dir,
      { fetchImpl }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MEDIA_VALIDATION_FAILED');
    expect(result.failures[0].reason).toBe('not_image');
  });
});

// ─── V5-P5A: ramo AUDIO (voz TTS real nas tracks <audio>) ──────────────────

function minimalMp3Buffer() {
  return Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(48, 0x00)]);
}

function minimalWavBuffer() {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4, 0x00),
    Buffer.from('WAVEfmt ', 'ascii'),
    Buffer.alloc(32, 0x00),
  ]);
}

function fakeFfprobeAudioStdout(duration = 3.5, codec = 'mp3') {
  return JSON.stringify({
    format: { duration: String(duration) },
    streams: [{ codec_type: 'audio', codec_name: codec }],
  });
}

describe('sniffAudioKind', () => {
  it('reconhece mp3 (ID3 e sync), wav e m4a; desconhecido → null', () => {
    expect(sniffAudioKind(minimalMp3Buffer())).toBe('mp3');
    expect(sniffAudioKind(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
    expect(sniffAudioKind(minimalWavBuffer())).toBe('wav');
    expect(sniffAudioKind(Buffer.concat([VALID_MP4_PREFIX, Buffer.alloc(16)]))).toBe('m4a');
    expect(sniffAudioKind(Buffer.from('<!doctype html><html>x</html>'))).toBeNull();
  });
});

describe('downloadAndValidateAudio (V5-P5A)', () => {
  it('mp3 feliz: grava assets/vp-media-{hash}.mp3 e devolve duração probeada', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-audio-'));
    const fetchImpl = makeFetchImpl(minimalMp3Buffer(), { contentType: 'audio/mpeg' });
    const spawnImpl = makeSpawnImpl({ stdout: fakeFfprobeAudioStdout(2.75, 'mp3') });

    const result = await downloadAndValidateAudio('https://x.supabase.co/sign/vo-1.mp3?token=t', dir, 'hashvo1', {
      fetchImpl,
      spawnImpl,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('mp3');
    expect(result.assetName).toBe('vp-media-hashvo1.mp3');
    expect(result.duration).toBeCloseTo(2.75);
    expect(readFileSync(join(dir, 'vp-media-hashvo1.mp3')).length).toBeGreaterThan(0);
  });

  it('wav → extensão .wav; m4a (ftyp com stream só de áudio) → .m4a', async () => {
    const dirWav = mkdtempSync(join(tmpdir(), 'vp-audio-'));
    const rWav = await downloadAndValidateAudio('https://x/a', dirWav, 'hashwav', {
      fetchImpl: makeFetchImpl(minimalWavBuffer(), { contentType: 'audio/wav' }),
      spawnImpl: makeSpawnImpl({ stdout: fakeFfprobeAudioStdout(1, 'pcm_s16le') }),
      timeoutMs: 5000,
    });
    expect(rWav.ok && rWav.assetName.endsWith('.wav')).toBe(true);

    const dirM4a = mkdtempSync(join(tmpdir(), 'vp-audio-'));
    const rM4a = await downloadAndValidateAudio('https://x/b', dirM4a, 'hashm4a', {
      fetchImpl: makeFetchImpl(Buffer.concat([VALID_MP4_PREFIX, Buffer.alloc(16)]), { contentType: 'audio/mp4' }),
      spawnImpl: makeSpawnImpl({ stdout: fakeFfprobeAudioStdout(1.5, 'aac') }),
      timeoutMs: 5000,
    });
    expect(rM4a.ok && rM4a.assetName.endsWith('.m4a')).toBe(true);
  });

  it('payload HTML → not_audio sem gravar ficheiro', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-audio-'));
    const result = await downloadAndValidateAudio('https://x/player', dir, 'hashhtml', {
      fetchImpl: makeFetchImpl(Buffer.from('<!doctype html><html>player</html>'), { contentType: 'text/html' }),
      spawnImpl: makeSpawnImpl({ stdout: fakeFfprobeAudioStdout() }),
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_audio');
  });

  it('ffprobe SEM stream de áudio (vídeo puro numa tag audio) → not_audio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-audio-'));
    const result = await downloadAndValidateAudio('https://x/video-named-mp3', dir, 'hashv', {
      fetchImpl: makeFetchImpl(minimalMp3Buffer(), { contentType: 'audio/mpeg' }),
      spawnImpl: makeSpawnImpl({ stdout: fakeFfprobeStdout() }), // streams só video
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_audio');
  });
});

describe('prestageExternalMedia × <audio> (V5-P5A)', () => {
  it('pré-estageia a voz assinada e reescreve o src para o asset local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const url = 'https://qwerty.supabase.co/storage/v1/object/sign/video-artifacts/p/audio/vo-1.mp3?token=abc';
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(minimalMp3Buffer(), { contentType: 'audio/mpeg' }));
    const spawnImpl = makeSpawnImpl({ stdout: fakeFfprobeAudioStdout() });

    const html = `<div data-composition-id="main"><audio id="scene-1-voice-1" src="${url}" data-track="vo" data-track-index="8" data-start="0" data-duration="3" preload="auto"></audio></div>`;
    const result = await prestageExternalMedia(html, dir, { fetchImpl, spawnImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.downloaded).toEqual([url]);
    expect(result.html).toContain('src="assets/vp-media-');
    expect(result.html).toMatch(/vp-media-[0-9a-f]+\.mp3/);
    expect(result.html).not.toContain(url);
    expect(result.html).toContain('data-track="vo"');
  });

  it('payload não-áudio numa tag <audio> falha o staging com not_audio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(Buffer.from('<!doctype html><html>player</html>'), { status: 200, contentType: 'text/html' })
    );

    const result = await prestageExternalMedia(
      '<audio id="scene-1-voice-1" src="https://cdn.example.com/vo-1.mp3"></audio>',
      dir,
      { fetchImpl }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MEDIA_VALIDATION_FAILED');
    expect(result.failures[0].reason).toBe('not_audio');
  });

  it('regressão: <video> continua a exigir MP4 (ramo áudio não vaza para vídeo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-media-'));
    // mp3 servido numa tag video → magic check do ramo mp4 reprova.
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(minimalMp3Buffer(), { contentType: 'audio/mpeg' }));

    const result = await prestageExternalMedia(
      '<video id="v1" src="https://cdn.example.com/intro.mp4"></video>',
      dir,
      { fetchImpl }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0].reason).toBe('not_mp4');
  });
});
