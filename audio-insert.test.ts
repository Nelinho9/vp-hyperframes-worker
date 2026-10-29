// @vitest-environment node
/**
 * E07 — reparação de voz omitida: INSERT/REMOVE do alvo de voz.
 *
 * Contrato: docs/video-engine/EVOLUCAO_EDITOR_ASSISTIDO_PRO_2026-10-13/
 *           15_E02_CONTRATOS_AUDIO_TEMPO.md §7.7.
 *
 * Uma voz excluída por `VO_WINDOW_OVERFLOW` não tem tag no HTML publicado; a
 * regeneração E02 só substitui `src` de um alvo existente. Este módulo é a
 * operação em falta: cria a tag canónica a partir da JANELA DA CENA (a mesma
 * que o render lê) e remove-a de volta com uma precondição de identidade,
 * para o undo/redo do journal E01.
 *
 * Invariantes:
 *   - alvo já presente → 409 (nunca duplicar ids);
 *   - cena ausente/sem janela válida → 409 (nunca inventar timing);
 *   - a tag criada é a canónica do build (sem `class="clip"`, sem
 *     `crossorigin`, com fades escalados à janela);
 *   - a remoção toca APENAS o alvo pedido e exige o `src` esperado por
 *     identidade de Storage (URL assinada ≡ path cru do journal).
 */
import { describe, expect, it } from 'vitest';
import { insertAudioTargets, removeAudioTargets } from './audio-insert.js';
import { prepareComposition } from './composition-editor.js';

const PID = '55555555-5555-4555-8555-555555555555';
const MUT = '77777777-7777-4777-8777-777777777777';
const NEW = 'https://media.example.test/candidate/vo-4.mp3?token=new';
const OLD = 'https://media.example.test/old/vo-4.mp3?token=old';
const OTHER = 'https://media.example.test/old/vo-1.mp3?token=other';
const CAND_PATH = `projects/${PID}/composition-revisions/${MUT}/audio/vo-4.mp3`;
const CAND_URL = `https://media.example.test/storage/v1/object/sign/video-artifacts/${CAND_PATH}?token=expiring`;
const STORAGE_CONTEXT = { storageUrl: 'https://media.example.test' };

// Cena 1 (0-3s) tem voz; cena 4 (9-12s) NÃO tem — é a voz omitida.
const SCENES = '<div id="scene-1" class="clip" data-start="0" data-duration="3"><h1 id="title">A</h1></div>'
  + '<div id="scene-4" class="clip" data-start="9" data-duration="3"><h2 id="sub">B</h2></div>';

const WITH_MARKERS = '<html><body><div data-composition-id="main" data-width="1080" data-height="1920" data-duration="12">'
  + SCENES
  + '<!-- __vp-audio-tracks:v1 -->\n'
  + `<audio id="scene-1-voice-1" src="${OTHER}" data-track="vo" data-track-index="8" data-start="0" data-duration="3" data-fade-in="200" data-fade-out="300" preload="auto"></audio>\n`
  + '<!-- /__vp-audio-tracks -->'
  + '</div></body></html>';

const WITHOUT_MARKERS = '<html><body><div data-composition-id="main" data-width="1080" data-height="1920" data-duration="12">'
  + SCENES
  + `<audio id="scene-1-voice-1" src="${OTHER}" data-track="vo" data-start="0" data-duration="3"></audio>`
  + '</div></body></html>';

describe('E07 insertAudioTargets', () => {
  it('cria a tag canónica na janela da cena, dentro do bloco de áudio e antes do marcador final', () => {
    const result = insertAudioTargets(WITH_MARKERS, [{ target_id: 'scene-4-voice-1', src: NEW }]);

    expect(result.applied).toBe(1);
    expect(result.undoable).toBe(true);
    expect(result.before).toEqual([]);
    expect(result.inserted).toEqual([{ target_id: 'scene-4-voice-1', scene_id: 'scene-4', start: 9, duration: 3 }]);

    const tag = /<audio\b[^>]*id="scene-4-voice-1"[^>]*><\/audio>/.exec(result.html)?.[0] ?? '';
    expect(tag).toContain(`src="${NEW}"`);
    expect(tag).toContain('data-track="vo"');
    expect(tag).toContain('data-track-index="8"');
    // linkedom serializa os atributos por ordem própria: cada valor é
    // verificado individualmente (a ordem não é semântica em HTML).
    expect(tag).toContain('data-start="9"');
    expect(tag).toContain('data-duration="3"');
    expect(tag).toContain('data-fade-in="200"');
    expect(tag).toContain('data-fade-out="300"');
    expect(tag).toContain('preload="auto"');
    expect(tag).not.toContain('class=');
    expect(tag).not.toContain('crossorigin');

    // Posição: dentro do bloco marcado (antes do `<!-- /__vp-audio-tracks -->`).
    const tagIndex = result.html.indexOf('id="scene-4-voice-1"');
    const startMarker = result.html.indexOf('__vp-audio-tracks:v1');
    const endMarker = result.html.indexOf('/__vp-audio-tracks');
    expect(startMarker).toBeGreaterThan(-1);
    expect(tagIndex).toBeGreaterThan(startMarker);
    expect(tagIndex).toBeLessThan(endMarker);

    // Não-alvos preservados.
    expect(result.html).toContain(OTHER);
    expect(result.html).toContain('id="scene-1"');
    expect(result.html).toContain('id="scene-4"');
    expect(WITH_MARKERS).not.toContain(NEW); // a fonte nunca é mutada
  });

  it('sem bloco marcado, anexa ao fim da composition root', () => {
    const result = insertAudioTargets(WITHOUT_MARKERS, [{ target_id: 'scene-4-voice-1', src: NEW }]);
    const tagIndex = result.html.indexOf('id="scene-4-voice-1"');
    const rootClose = result.html.lastIndexOf('</div></body>');
    expect(tagIndex).toBeGreaterThan(result.html.indexOf('id="scene-1-voice-1"'));
    expect(tagIndex).toBeLessThan(rootClose);
    expect(result.html).toContain(OTHER);
  });

  it('escala os fades à janela (janela curta nunca fica com fades a comerem a locução)', () => {
    const short = WITHOUT_MARKERS.replace('id="scene-4" class="clip" data-start="9" data-duration="3"', 'id="scene-4" class="clip" data-start="9" data-duration="0.4"');
    const result = insertAudioTargets(short, [{ target_id: 'scene-4-voice-1', src: NEW }]);
    const tag = /<audio\b[^>]*id="scene-4-voice-1"[^>]*>/.exec(result.html)?.[0] ?? '';
    expect(tag).toContain('data-fade-in="0"');
    expect(tag).toContain('data-fade-out="0"');
  });

  it('recusa 409 um alvo que já existe (nunca duplica ids)', () => {
    expect(() => insertAudioTargets(WITH_MARKERS, [{ target_id: 'scene-1-voice-1', src: NEW }]))
      .toThrowError(expect.objectContaining({ code: 'AUDIO_TARGET_PRESENT', status: 409 }));
  });

  it('recusa 409 uma cena ausente ou sem janela válida', () => {
    expect(() => insertAudioTargets(WITH_MARKERS, [{ target_id: 'scene-9-voice-1', src: NEW }]))
      .toThrowError(expect.objectContaining({ code: 'AUDIO_SCENE_NOT_FOUND', status: 409 }));
    const noWindow = WITHOUT_MARKERS.replace(' id="scene-4" class="clip" data-start="9" data-duration="3"', ' id="scene-4" class="clip"');
    expect(() => insertAudioTargets(noWindow, [{ target_id: 'scene-4-voice-1', src: NEW }]))
      .toThrowError(expect.objectContaining({ code: 'AUDIO_SCENE_WINDOW_INVALID', status: 409 }));
    const zero = WITHOUT_MARKERS.replace('data-start="9" data-duration="3"', 'data-start="9" data-duration="0"');
    expect(() => insertAudioTargets(zero, [{ target_id: 'scene-4-voice-1', src: NEW }]))
      .toThrowError(expect.objectContaining({ code: 'AUDIO_SCENE_WINDOW_INVALID', status: 409 }));
  });

  it('recusa listas malformadas, ids fora do formato e srcs inseguros', () => {
    for (const insertions of [
      [], 'nope', [{ target_id: 'scene-4-voice-1' }],
      [{ target_id: 'scene-4-voice-1', src: '' }],
      [{ target_id: 'scene-4-voice-1', src: 'javascript:alert(1)' }],
      [{ target_id: 'scene-4-voice-1', src: 'https://x.test/a"onload="evil()' }],
      [{ target_id: 'scene-4-voice-1', src: ` projects/${PID}/x.mp3` }],
      [{ target_id: 'scene-4', src: NEW }],
      [{ target_id: 'scene-4-voice-1', src: NEW }, { target_id: 'scene-4-voice-1', src: NEW }],
      Array.from({ length: 9 }, (_, i) => ({ target_id: `scene-4-voice-${i + 1}`, src: NEW })),
    ]) {
      expect(() => insertAudioTargets(WITH_MARKERS, insertions as never)).toThrowError(/INVALID_AUDIO_INSERTIONS/);
    }
    expect(() => insertAudioTargets('', [{ target_id: 'scene-4-voice-1', src: NEW }]))
      .toThrowError(/INVALID_COMPOSITION_HTML/);
  });
});

describe('E07 removeAudioTargets', () => {
  const inserted = insertAudioTargets(WITH_MARKERS, [{ target_id: 'scene-4-voice-1', src: NEW }]).html;

  it('remove apenas o alvo pedido e devolve o read-set', () => {
    const result = removeAudioTargets(inserted, [{ target_id: 'scene-4-voice-1' }]);
    expect(result.applied).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.undoable).toBe(true);
    expect(result.before).toEqual([{ target_id: 'scene-4-voice-1', src: NEW }]);
    expect(result.html).not.toContain('id="scene-4-voice-1"');
    expect(result.html).toContain(OTHER);
    expect(result.html).toContain('id="scene-4"');
    expect(result.html).toContain('/__vp-audio-tracks');
  });

  it('exige a precondição por identidade de Storage (URL assinada ≡ path cru)', () => {
    const postCommit = insertAudioTargets(WITH_MARKERS, [{ target_id: 'scene-4-voice-1', src: CAND_URL }]).html;
    for (const expected of [CAND_URL, CAND_PATH]) {
      const result = removeAudioTargets(postCommit, [{ target_id: 'scene-4-voice-1' }],
        [{ target_id: 'scene-4-voice-1', src: expected }], STORAGE_CONTEXT);
      expect(result.applied).toBe(1);
    }
  });

  it('recusa 409 com conflicts quando o alvo foi substituído por outra regeneração', () => {
    const later = `projects/${PID}/composition-revisions/99999999-9999-4999-8999-999999999999/audio/vo-4.mp3`;
    const laterUrl = `https://media.example.test/storage/v1/object/sign/video-artifacts/${later}?token=live`;
    const diverged = insertAudioTargets(WITH_MARKERS, [{ target_id: 'scene-4-voice-1', src: laterUrl }]).html;
    let thrown = null;
    try {
      removeAudioTargets(diverged, [{ target_id: 'scene-4-voice-1' }],
        [{ target_id: 'scene-4-voice-1', src: CAND_PATH }], STORAGE_CONTEXT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('UNDO_PRECONDITION_CONFLICT');
    expect(thrown?.status).toBe(409);
    expect(thrown?.conflicts).toEqual([{ target_id: 'scene-4-voice-1', observed: laterUrl, expected: CAND_PATH }]);
  });

  it('valida tudo antes de escrever (nada meio-removido num 409)', () => {
    const diverged = insertAudioTargets(WITH_MARKERS, [{ target_id: 'scene-4-voice-1', src: NEW }]).html;
    let thrown = null;
    try {
      removeAudioTargets(diverged, [
        { target_id: 'scene-1-voice-1' },
        { target_id: 'scene-4-voice-1' },
      ], [{ target_id: 'scene-4-voice-1', src: CAND_PATH }], STORAGE_CONTEXT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('UNDO_PRECONDITION_CONFLICT');
    expect(thrown?.conflicts).toHaveLength(1);
  });

  it('recusa 409 alvo ausente ou não-voz', () => {
    expect(() => removeAudioTargets(WITH_MARKERS, [{ target_id: 'scene-4-voice-1' }]))
      .toThrowError(expect.objectContaining({ code: 'AUDIO_TARGET_NOT_FOUND', status: 409 }));
    // Ids existentes que não são a faixa VO são recusados como não-voz.
    expect(() => removeAudioTargets(WITH_MARKERS, [{ target_id: 'title' }]))
      .toThrowError(expect.objectContaining({ code: 'AUDIO_TARGET_NOT_VOICE', status: 409 }));
    expect(() => removeAudioTargets(WITH_MARKERS, [{ target_id: 'scene-1' }]))
      .toThrowError(expect.objectContaining({ code: 'AUDIO_TARGET_NOT_VOICE', status: 409 }));
  });

  it('recusa listas malformadas e precondições inválidas', () => {
    for (const removals of [[], 'nope', [{}], [{ target_id: 'a b' }],
      [{ target_id: 'scene-1-voice-1' }, { target_id: 'scene-1-voice-1' }]]) {
      expect(() => removeAudioTargets(WITH_MARKERS, removals as never)).toThrowError(/INVALID_AUDIO_REMOVALS/);
    }
    for (const expected of [[{ target_id: 'scene-4-voice-1', src: CAND_PATH }], [{ target_id: 'title', src: CAND_PATH }], [{ target_id: 'scene-1-voice-1' }]]) {
      expect(() => removeAudioTargets(WITH_MARKERS, [{ target_id: 'scene-1-voice-1' }], expected as never))
        .toThrowError(/INVALID_EXPECTED_SRC/);
    }
  });
});

describe('E07 prepare-audio insert/remove modes', () => {
  it('devolve inserted_audio e um registry coerente na revisão nova', () => {
    const prepared = prepareComposition('audio', {
      source_html: WITH_MARKERS, revision: 46,
      insertions: [{ target_id: 'scene-4-voice-1', src: NEW }],
    });
    expect(prepared.prepared).toBe(true);
    expect(prepared.applied).toBe(1);
    expect(prepared.inserted_audio).toBe(1);
    expect(prepared.undoable).toBe(true);
    expect(prepared.before_audio).toEqual([]);
    expect(prepared.html).toContain('id="scene-4-voice-1"');
    expect(prepared.elements.revision).toBe(46);
    expect(prepared.elements.elements.find((e: { id: string }) => e.id === 'scene-4-voice-1')).toBeTruthy();
  });

  it('devolve removed_audio e o read-set da remoção', () => {
    const withVoice = insertAudioTargets(WITH_MARKERS, [{ target_id: 'scene-4-voice-1', src: NEW }]).html;
    const prepared = prepareComposition('audio', {
      source_html: withVoice, revision: 47,
      removals: [{ target_id: 'scene-4-voice-1' }],
    });
    expect(prepared.applied).toBe(1);
    expect(prepared.removed_audio).toBe(1);
    expect(prepared.before_audio).toEqual([{ target_id: 'scene-4-voice-1', src: NEW }]);
    expect(prepared.html).not.toContain('id="scene-4-voice-1"');
    expect(prepared.elements.elements.find((e: { id: string }) => e.id === 'scene-4-voice-1')).toBeFalsy();
  });

  it('recusa modos em simultâneo ou ausentes', () => {
    for (const input of [
      { source_html: WITH_MARKERS, revision: 4 },
      { source_html: WITH_MARKERS, revision: 4, insertions: [{ target_id: 'scene-4-voice-1', src: NEW }], removals: [{ target_id: 'scene-1-voice-1' }] },
    ]) {
      expect(() => prepareComposition('audio', input as never)).toThrowError(/INVALID_AUDIO_OPERATION/);
    }
  });
});
