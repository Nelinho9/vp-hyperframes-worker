// @vitest-environment node
/**
 * audio-presets.test.ts — V5-P5B/S23 (§10.3): bloco materializador de
 * volume/fades de áudio no worker + integração com applyPatchesLinkedom.
 * Paridade SEMÂNTICA com src/video/v4/audioMaterialize.ts (repos separados).
 */
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  AUDIO_APPLY_SOURCE,
  AUDIO_APPLY_FN_NAME,
  AUDIO_BLOCK_ID,
  buildAudioBlock,
  touchesAudioProps,
  upsertAudioBlock,
} from './audio-presets.js';
import { applyPatchesLinkedom } from './patch-engine.js';

const HTML = `
<html><body>
  <div data-composition-id="main" data-duration="9">
    <div id="scene-1" class="clip" data-start="0" data-duration="9"></div>
    <audio id="bgm-main" src="assets/bgm.mp3" data-track="bgm" data-track-index="9" data-start="0" data-duration="9" data-volume="0.3" data-fade-in="1500" data-fade-out="3000" preload="auto"></audio>
  </div>
</body></html>
`;

describe('AUDIO_APPLY_SOURCE (fonte ES5 partilhada)', () => {
  it('contém os guards obrigatórios e o canal data-* (paridade semântica com a app)', () => {
    expect(AUDIO_APPLY_SOURCE.startsWith(`function ${AUDIO_APPLY_FN_NAME}`)).toBe(true);
    expect(AUDIO_APPLY_SOURCE).toContain('__timelines');
    expect(AUDIO_APPLY_SOURCE).toContain('"data-fade-in"');
    expect(AUDIO_APPLY_SOURCE).toContain('"data-fade-out"');
    expect(AUDIO_APPLY_SOURCE).toContain('"data-volume"');
    expect(AUDIO_APPLY_SOURCE).toContain('killTweensOf');
    expect(AUDIO_APPLY_SOURCE).toContain('fromTo');
    // ES5 estrito: sem arrow functions nem let/const.
    expect(AUDIO_APPLY_SOURCE).not.toMatch(/=>/);
    expect(AUDIO_APPLY_SOURCE).not.toMatch(/\blet\s/);
    expect(AUDIO_APPLY_SOURCE).not.toMatch(/\bconst\s/);
  });
});

describe('buildAudioBlock / upsertAudioBlock', () => {
  it('bloco único antes de </body>; upsert substitui (idempotente)', () => {
    const once = upsertAudioBlock(HTML);
    expect(once.split(AUDIO_BLOCK_ID).length - 1).toBe(1);
    expect(once.indexOf(AUDIO_BLOCK_ID)).toBeLessThan(once.lastIndexOf('</body>'));
    const twice = upsertAudioBlock(once);
    expect(twice).toBe(once);
  });

  it('buildAudioBlock embrulha em try/catch', () => {
    expect(buildAudioBlock()).toContain('<script');
    expect(buildAudioBlock()).toContain('catch');
  });
});

describe('touchesAudioProps / applyPatchesLinkedom × áudio (V5-P5C)', () => {
  it('deteção de lote de áudio', () => {
    expect(touchesAudioProps([{ selector: '#a', property: 'volume' }])).toBe(true);
    expect(touchesAudioProps([{ selector: '#a', property: 'fadeOut' }])).toBe(true);
    expect(touchesAudioProps([{ selector: '#a', property: 'opacity' }])).toBe(false);
    expect(touchesAudioProps([])).toBe(false);
  });

  it('patch volume → data-volume escrito E bloco regenerado', () => {
    const { html } = applyPatchesLinkedom(HTML, [
      { selector: '#bgm-main', property: 'volume', value: '0.4' },
    ]);
    const { document } = parseHTML(html);
    expect(document.getElementById('bgm-main').getAttribute('data-volume')).toBe('0.4');
    expect(html.split(AUDIO_BLOCK_ID).length - 1).toBe(1);
  });

  it('lote sem áudio não adiciona o bloco', () => {
    const { html } = applyPatchesLinkedom(HTML, [
      { selector: '#scene-1', property: 'opacity', value: '0.5' },
    ]);
    expect(html).not.toContain(AUDIO_BLOCK_ID);
  });

  it('idempotente: re-aplicação converge byte-exato', () => {
    const once = applyPatchesLinkedom(HTML, [
      { selector: '#bgm-main', property: 'fadeIn', value: '800' },
    ]).html;
    const twice = applyPatchesLinkedom(once, [
      { selector: '#bgm-main', property: 'fadeIn', value: '800' },
    ]).html;
    expect(twice).toBe(once);
  });
});
