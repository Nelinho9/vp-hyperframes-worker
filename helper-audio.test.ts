// @vitest-environment node
/**
 * helper-audio.test.ts — V5-P5C §2.1: o helper vendido transporta props de
 * áudio VIVAS no select, reconhece a track BGM e re-aplica o estado/fades
 * após patches de áudio (paridade com audio-presets.js — MESMA fonte
 * interpolada em PREVIEW_HELPER_SCRIPT).
 */
import { describe, expect, it } from 'vitest';
import { AUDIO_APPLY_SOURCE } from './audio-presets.js';
import { PREVIEW_HELPER_SCRIPT } from './preview-helper.js';

describe('PREVIEW_HELPER_SCRIPT × áudio (V5-P5C)', () => {
  it('interpola a MESMA fonte do applier (paridade por construção)', () => {
    // O helper embute a fonte via ${AUDIO_APPLY_SOURCE} — verificamos que os
    // marcadores únicos da fonte estão presentes no script gerado.
    expect(AUDIO_APPLY_SOURCE).toContain('__vpApplyAudioProps');
    expect(PREVIEW_HELPER_SCRIPT).toContain('__vpApplyAudioProps');
    expect(PREVIEW_HELPER_SCRIPT).toContain('applyLiveAudioState');
    expect(PREVIEW_HELPER_SCRIPT).toContain('patchTouchesAudio');
  });

  it('reconhece a track BGM na inferência de tipo', () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("tok === 'bgm'");
  });

  it('select transporta as props de áudio vivas (parse dos data-*)', () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain('parseAudioAttrs');
    expect(PREVIEW_HELPER_SCRIPT).toContain("msg.audio = parseAudioAttrs(el)");
  });

  it('lote de patch toca o caminho vivo do volume/mute', () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("pr === 'volume'");
    expect(PREVIEW_HELPER_SCRIPT).toContain("el.getAttribute('data-muted') === 'true'");
  });
});
