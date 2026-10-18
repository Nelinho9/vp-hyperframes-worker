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
    // E02/I4 §8: o mesmo canal que o preview-helper consome (paridade).
    expect(AUDIO_APPLY_SOURCE).toContain('"data-muted"');
    expect(AUDIO_APPLY_SOURCE).toContain('el.muted = muted');
    expect(AUDIO_APPLY_SOURCE).toContain('audio[data-volume],audio[data-muted],audio[data-fade-in],audio[data-fade-out]');
    expect(AUDIO_APPLY_SOURCE).toContain('killTweensOf');
    expect(AUDIO_APPLY_SOURCE).toContain('fromTo');
    // ES5 estrito: sem arrow functions nem let/const.
    expect(AUDIO_APPLY_SOURCE).not.toMatch(/=>/);
    expect(AUDIO_APPLY_SOURCE).not.toMatch(/\blet\s/);
    expect(AUDIO_APPLY_SOURCE).not.toMatch(/\bconst\s/);
  });
});

/**
 * E02/I4 (AUD-04, vetores locais): a fonte ES5 é EXECUTADA contra um DOM/gsap
 * instrumentados — o oráculo é o gain efetivo aplicado e os tweens criados,
 * não a presença de strings. `mute=0` é o vetor do §8.
 */
function runAudioApplier(elements: Array<Record<string, string>>) {
  const tweens: Array<{ id: string; from: number; to: number; duration: number; at: number }> = [];
  const nodes = elements.map((attrs) => ({
    id: attrs.id,
    muted: false,
    volume: 1,
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
  }));
  const window = {
    __timelines: { main: { fromTo: (el: { id: string }, from: { volume: number }, to: { volume: number; duration: number }, at: number) => {
      // Assinatura real do gsap: fromTo(target, fromVars, toVars, position).
      tweens.push({ id: el.id, from: from.volume, to: to.volume, duration: to.duration, at });
    } } },
    gsap: { killTweensOf: () => {} },
  };
  const document = { readyState: 'complete', addEventListener: () => {}, querySelectorAll: () => nodes };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', AUDIO_APPLY_SOURCE)(window, document);
  return { nodes, tweens };
}

describe('E02/I4 — gain efetivo, mute dominante e envelopes lineares (§8)', () => {
  it('mute=0 domina gain e fades, sem alterar os valores authored', () => {
    const { nodes, tweens } = runAudioApplier([
      { id: 'vo-1', 'data-volume': '0.8', 'data-muted': 'true', 'data-fade-in': '500', 'data-fade-out': '500', 'data-start': '0', 'data-duration': '5' },
    ]);
    expect(nodes[0].muted).toBe(true);
    expect(nodes[0].volume).toBe(0); // vetor AUD-04: mute de PCM = 0
    expect(tweens).toHaveLength(0); // nada para rampar: zero em qualquer seek
  });

  it('unmute restaura o gain authored (data-volume nunca é reescrito)', () => {
    const { nodes } = runAudioApplier([
      { id: 'vo-1', 'data-volume': '0.501187', 'data-muted': 'false', 'data-start': '0', 'data-duration': '5' },
    ]);
    expect(nodes[0].muted).toBe(false);
    expect(nodes[0].volume).toBe(0.501187); // −6 dB de amplitude
  });

  it('clip só com volume/mute (sem fades) passa a ser materializado', () => {
    const { nodes, tweens } = runAudioApplier([
      { id: 'vo-2', 'data-volume': '0.3', 'data-start': '0', 'data-duration': '5' },
      { id: 'vo-3', 'data-muted': 'true', 'data-duration': '5' },
    ]);
    expect(nodes[0].volume).toBe(0.3);
    expect(nodes[1].volume).toBe(0);
    expect(tweens).toHaveLength(0);
  });

  it('fades são envelopes lineares de amplitude na janela do clip', () => {
    const { tweens } = runAudioApplier([
      { id: 'bgm', 'data-volume': '0.3', 'data-fade-in': '1500', 'data-fade-out': '3000', 'data-start': '1', 'data-duration': '9' },
    ]);
    expect(tweens).toEqual([
      { id: 'bgm', from: 0, to: 0.3, duration: 1.5, at: 1 },
      { id: 'bgm', from: 0.3, to: 0, duration: 3, at: 7 },
    ]);
  });

  it('guard de overlap mantém 500ms intactos e limita o excedente', () => {
    const { tweens } = runAudioApplier([
      { id: 'vo-4', 'data-volume': '1', 'data-fade-in': '1000', 'data-fade-out': '1000', 'data-start': '0', 'data-duration': '1.2' },
    ]);
    // maxFade = 1.2 − 0.5 = 0.7s repartido proporcionalmente.
    expect(tweens[0].duration).toBeCloseTo(0.35, 6);
    expect(tweens[1].duration).toBeCloseTo(0.35, 6);
  });

  it('gain é clampado a [0,1] e durações inválidas não criam tweens', () => {
    const { nodes, tweens } = runAudioApplier([
      { id: 'a', 'data-volume': '1.5', 'data-fade-in': '500', 'data-duration': '5' },
      { id: 'b', 'data-volume': '-3', 'data-fade-out': '500', 'data-duration': '5' },
      { id: 'c', 'data-volume': '0.5', 'data-fade-in': '500' },
      { id: 'd', 'data-volume': '0.5', 'data-fade-in': '500', 'data-duration': '0' },
    ]);
    expect(nodes[0].volume).toBe(1);
    expect(nodes[1].volume).toBe(0);
    // Sem duração válida o estado vivo (volume/mute) ainda é aplicado — o
    // preview faz o mesmo em applyLiveAudioState.
    expect(nodes[2].volume).toBe(0.5);
    expect(nodes[3].volume).toBe(0.5);
    expect(tweens.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('data-muted só é verdadeiro com o literal "true" (paridade com o preview)', () => {
    const { nodes } = runAudioApplier([
      { id: 'a', 'data-muted': 'false', 'data-duration': '5' },
      { id: 'b', 'data-muted': '', 'data-duration': '5' },
      { id: 'c', 'data-muted': 'yes', 'data-duration': '5' },
      { id: 'd', 'data-muted': 'true', 'data-duration': '5' },
    ]);
    expect(nodes.map((n) => n.muted)).toEqual([false, false, false, true]);
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
