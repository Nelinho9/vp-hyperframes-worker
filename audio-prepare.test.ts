// @vitest-environment node
/**
 * E02/I3 — substituição alvo-única do `src` de faixas de voz (audio-prepare)
 * + integração no prepare do worker (`prepare-audio`).
 *
 * Oráculos do contrato §7.4: só o alvo muda, o read-set (`before_audio`) sai
 * para o journal, e um alvo ausente é ERRO — nunca um "aplicado" mudo.
 * C2.3/R04: `expected_src` é a precondição do undo/redo — divergência é 409
 * ANTES de qualquer mutação, correlacionada por OBJECT KEY (URL assinada ≡
 * path cru do namespace imutável gravado no journal).
 */
import { describe, expect, it } from 'vitest';
import { replaceAudioTargets } from './audio-prepare.js';
import { compositionHash, createCompositionEditor, prepareComposition } from './composition-editor.js';

const OLD = 'https://media.example.test/old/vo-2.mp3?token=aaa';
const NEW = 'https://media.example.test/candidate/vo-2.mp3?token=bbb';
const OTHER = 'https://media.example.test/old/vo-3.mp3?token=ccc';
const PID = '55555555-5555-4555-8555-555555555555';
const MUT = '77777777-7777-4777-8777-777777777777';
const CAND_PATH = `projects/${PID}/composition-revisions/${MUT}/audio/vo-2.mp3`;
const CAND_URL = `https://media.example.test/storage/v1/object/sign/video-artifacts/${CAND_PATH}?token=expiring`;
const STORAGE_CONTEXT = { storageUrl: 'https://media.example.test' };

const HTML = '<html><body><div data-composition-id="main" data-width="1080" data-height="1920" data-duration="5">'
  + '<div id="scene-2" class="clip" data-start="0" data-duration="5" data-track-index="0"><h1 id="title">T</h1></div>'
  + `<audio id="scene-2-voice-1" data-track="vo" src="${OLD}" data-start="0" data-duration="5" data-volume="0.8" data-muted="false" data-fade-in="200"></audio>`
  + `<audio id="scene-3-voice-1" data-track="vo" src="${OTHER}" data-start="0" data-duration="5"></audio>`
  + '<audio id="bgm-main" data-track="bgm" src="https://media.example.test/bgm.mp3" data-volume="0.8"></audio>'
  + '</div></body></html>';

describe('E02 audio target replacement', () => {
  it('rewrites only the requested voice src and preserves window and mix attributes', () => {
    const result = replaceAudioTargets(HTML, [{ target_id: 'scene-2-voice-1', src: NEW }]);
    expect(result.applied).toBe(1);
    expect(result.undoable).toBe(true);
    expect(result.before).toEqual([{ target_id: 'scene-2-voice-1', src: OLD }]);
    expect(result.html).toContain(`src="${NEW}"`);
    expect(result.html).not.toContain(OLD);
    // Não-alvos byte-a-byte: outra VO, a BGM e a cena ficam intactos.
    expect(result.html).toContain(OTHER);
    expect(result.html).toContain('https://media.example.test/bgm.mp3');
    expect(result.html).toContain('data-start="0" data-duration="5" data-volume="0.8" data-muted="false" data-fade-in="200"');
    expect(HTML).toContain(OLD); // fonte nunca é mutada in-place
  });

  it('replaces several targets of one scene in a single pure preparation', () => {
    const SECOND = 'https://media.example.test/old/vo-2b.mp3';
    const two = HTML.replace('<audio id="scene-3-voice-1"', `<audio id="scene-2-voice-2" data-track="vo" src="${SECOND}" data-start="0" data-duration="5"></audio>`
      + '<audio id="scene-3-voice-1"');
    const result = replaceAudioTargets(two, [
      { target_id: 'scene-2-voice-1', src: NEW },
      { target_id: 'scene-2-voice-2', src: `${NEW}&k=2` },
    ]);
    expect(result.applied).toBe(2);
    expect(result.before).toEqual([
      { target_id: 'scene-2-voice-1', src: OLD },
      { target_id: 'scene-2-voice-2', src: SECOND },
    ]);
    expect(result.html).toContain('src="' + NEW + '&k=2"');
    expect(result.html).not.toContain(SECOND);
    expect(result.html).toContain(OTHER); // a VO de outra cena não é tocada
  });

  it('fails closed on a missing or non-voice target instead of reporting success', () => {
    expect(() => replaceAudioTargets(HTML, [{ target_id: 'scene-9-voice-1', src: NEW }]))
      .toThrowError(/AUDIO_TARGET_NOT_FOUND/);
    expect(() => replaceAudioTargets(HTML, [{ target_id: 'bgm-main', src: NEW }]))
      .toThrowError(/AUDIO_TARGET_NOT_VOICE/);
    expect(() => replaceAudioTargets(HTML, [{ target_id: 'title', src: NEW }]))
      .toThrowError(/AUDIO_TARGET_NOT_VOICE/);
    const noSrc = HTML.replace(` src="${OLD}"`, '');
    expect(() => replaceAudioTargets(noSrc, [{ target_id: 'scene-2-voice-1', src: NEW }]))
      .toThrowError(/AUDIO_TARGET_WITHOUT_SRC/);
  });

  it('rejects malformed replacements, duplicate identities and unsafe src values', () => {
    for (const replacements of [
      [], 'nope', [{ target_id: 'scene-2-voice-1' }],
      [{ target_id: 'scene-2-voice-1', src: '' }],
      [{ target_id: 'scene-2-voice-1', src: 'javascript:alert(1)' }],
      [{ target_id: 'scene-2-voice-1', src: 'https://x.test/a"onload="evil()' }],
      [{ target_id: 'scene-2-voice-1', src: 'https://x.test/a b.mp3' }],
      [{ target_id: 'a b', src: NEW }],
      [{ target_id: 'scene-2-voice-1', src: NEW }, { target_id: 'scene-2-voice-1', src: NEW }],
      Array.from({ length: 9 }, (_, i) => ({ target_id: `scene-2-voice-${i + 1}`, src: NEW })),
    ]) {
      expect(() => replaceAudioTargets(HTML, replacements as never)).toThrowError(/INVALID_AUDIO_REPLACEMENTS/);
    }
    expect(() => replaceAudioTargets('', [{ target_id: 'scene-2-voice-1', src: NEW }]))
      .toThrowError(/INVALID_COMPOSITION_HTML/);
  });
});

describe('C2.3/R04 — precondição expected_src (read-set do undo/redo)', () => {
  // Pós-regeneração: o src publicado do alvo é o URL ASSINADO do candidato;
  // o journal do comando grava o PATH CRU. O guard correlaciona ambos.
  const postCommit = HTML.replace(`src="${OLD}"`, `src="${CAND_URL}"`);

  it('aceita a precondição quando o src atual correlaciona por object key (URL ≡ path cru)', () => {
    const result = replaceAudioTargets(postCommit, [{ target_id: 'scene-2-voice-1', src: NEW }],
      [{ target_id: 'scene-2-voice-1', src: CAND_PATH }], STORAGE_CONTEXT);
    expect(result.applied).toBe(1);
    expect(result.before).toEqual([{ target_id: 'scene-2-voice-1', src: CAND_URL }]);
    expect(result.html).toContain(`src="${NEW}"`);
  });

  it('aceita a precondição quando ambos os lados são URLs assinados do mesmo objeto', () => {
    const result = replaceAudioTargets(postCommit, [{ target_id: 'scene-2-voice-1', src: NEW }],
      [{ target_id: 'scene-2-voice-1', src: `${CAND_URL}&rotated=1` }]);
    expect(result.applied).toBe(1);
  });

  it.each([
    ['host', CAND_URL.replace('media.example.test', 'other.example.test')],
    ['bucket', CAND_URL.replace('/video-artifacts/', '/other-bucket/')],
    ['scheme', CAND_URL.replace('https:', 'http:')],
    ['port', CAND_URL.replace('media.example.test', 'media.example.test:8443')],
  ])('C2.5/R04: rejects a different Storage %s with the same object path', (_kind, observed) => {
    const current = HTML.replace(`src="${OLD}"`, `src="${observed}"`);
    for (const expected of [CAND_URL, CAND_PATH]) {
      expect(() => replaceAudioTargets(current, [{ target_id: 'scene-2-voice-1', src: NEW }],
        [{ target_id: 'scene-2-voice-1', src: expected }], STORAGE_CONTEXT))
        .toThrowError(expect.objectContaining({ code: 'UNDO_PRECONDITION_CONFLICT', status: 409,
          conflicts: [{ target_id: 'scene-2-voice-1', observed, expected }] }));
    }
  });

  it.each(['public', 'authenticated', ''])('C2.5/R04: access mode %s and rotated tokens preserve Storage identity', mode => {
    const observed = CAND_URL.replace('/sign/', mode ? `/${mode}/` : '/').replace('?token=expiring', '?token=new#fragment');
    const current = HTML.replace(`src="${OLD}"`, `src="${observed}"`);
    for (const expected of [CAND_URL, CAND_PATH]) {
      expect(replaceAudioTargets(current, [{ target_id: 'scene-2-voice-1', src: NEW }],
        [{ target_id: 'scene-2-voice-1', src: expected }], STORAGE_CONTEXT).applied).toBe(1);
    }
  });

  it('C2.5/R04: absent/invalid trusted storage never infers authority for a raw journal path', () => {
    for (const context of [undefined, { storageUrl: 'invalid' }]) {
      expect(() => replaceAudioTargets(postCommit, [{ target_id: 'scene-2-voice-1', src: NEW }],
        [{ target_id: 'scene-2-voice-1', src: CAND_PATH }], context))
        .toThrowError(expect.objectContaining({ code: 'UNDO_PRECONDITION_CONFLICT', status: 409 }));
    }
  });

  it('C2.5/R04: malformed percent encoding conflicts instead of throwing an unstructured URI error', () => {
    const malformed = CAND_URL.replace('vo-2.mp3', 'bad%ZZ.mp3');
    const current = HTML.replace(`src="${OLD}"`, `src="${malformed}"`);
    expect(() => replaceAudioTargets(current, [{ target_id: 'scene-2-voice-1', src: NEW }],
      [{ target_id: 'scene-2-voice-1', src: CAND_PATH }], STORAGE_CONTEXT))
      .toThrowError(expect.objectContaining({ code: 'UNDO_PRECONDITION_CONFLICT', status: 409 }));
  });

  it('C2.4/R04: uma query de versão alterada fora do Storage é conflito, nunca rotação de assinatura', () => {
    const expected = 'https://media.example.test/voice.mp3?version=1';
    const observed = 'https://media.example.test/voice.mp3?version=2';
    const current = HTML.replace(`src="${OLD}"`, `src="${observed}"`);
    expect(() => replaceAudioTargets(current, [{ target_id: 'scene-2-voice-1', src: NEW }],
      [{ target_id: 'scene-2-voice-1', src: expected }]))
      .toThrowError(expect.objectContaining({ code: 'UNDO_PRECONDITION_CONFLICT', status: 409,
        conflicts: [{ target_id: 'scene-2-voice-1', observed, expected }] }));
  });

  it('C2.4/R04: um URL opaco idêntico mantém query e fragmento e pode ser desfeito', () => {
    const src = 'https://media.example.test/voice.mp3?version=1#t=0,4';
    const current = HTML.replace(`src="${OLD}"`, `src="${src}"`);
    const result = replaceAudioTargets(current, [{ target_id: 'scene-2-voice-1', src: NEW }],
      [{ target_id: 'scene-2-voice-1', src }]);
    expect(result.before).toEqual([{ target_id: 'scene-2-voice-1', src }]);
    expect(result.applied).toBe(1);
  });

  it('recusa 409 com conflicts estruturados quando o alvo foi substituído por regeneração posterior', () => {
    const later = `projects/${PID}/composition-revisions/99999999-9999-4999-8999-999999999999/audio/vo-2.mp3`;
    const laterUrl = `https://media.example.test/storage/v1/object/sign/video-artifacts/${later}?token=live`;
    const diverged = HTML.replace(`src="${OLD}"`, `src="${laterUrl}"`);
    let thrown = null;
    try {
      replaceAudioTargets(diverged, [{ target_id: 'scene-2-voice-1', src: NEW }],
        [{ target_id: 'scene-2-voice-1', src: CAND_PATH }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('UNDO_PRECONDITION_CONFLICT');
    expect(thrown.status).toBe(409);
    expect(thrown.conflicts).toEqual([{
      target_id: 'scene-2-voice-1',
      observed: laterUrl,
      expected: CAND_PATH,
    }]);
  });

  it('o 409 de precondição nunca deixa o HTML meio-aplicado (valida tudo antes de escrever)', () => {
    const two = HTML.replace('<audio id="scene-3-voice-1"', `<audio id="scene-2-voice-2" data-track="vo" src="${OTHER}" data-start="0" data-duration="5"></audio>`
      + '<audio id="scene-3-voice-1"');
    // O PRIMEIRO alvo diverge; o segundo estaria ok — nada é escrito.
    let thrown = null;
    try {
      replaceAudioTargets(two, [
        { target_id: 'scene-2-voice-1', src: NEW },
        { target_id: 'scene-2-voice-2', src: `${NEW}&k=2` },
      ], [{ target_id: 'scene-2-voice-1', src: CAND_PATH }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('UNDO_PRECONDITION_CONFLICT');
    expect(thrown?.conflicts).toHaveLength(1);
  });

  it('recusa expected_src malformado, com alvo fora dos replacements ou duplicado', () => {
    for (const expectedSrc of [
      'nope', [],
      [{ target_id: 'scene-2-voice-1' }],
      [{ target_id: 'scene-2-voice-1', src: '' }],
      [{ target_id: 'scene-2-voice-1', src: 'javascript:alert(1)' }],
      [{ target_id: 'scene-3-voice-1', src: CAND_PATH }], // fora dos replacements
      [{ target_id: 'scene-2-voice-1', src: CAND_PATH }, { target_id: 'scene-2-voice-1', src: CAND_PATH }],
      Array.from({ length: 9 }, () => ({ target_id: 'scene-2-voice-1', src: CAND_PATH })),
    ]) {
      expect(() => replaceAudioTargets(postCommit, [{ target_id: 'scene-2-voice-1', src: NEW }], expectedSrc))
        .toThrowError(/INVALID_EXPECTED_SRC/);
    }
  });

  it('sem expected_src o comportamento é o anterior (compatibilidade da regeneração)', () => {
    const result = replaceAudioTargets(postCommit, [{ target_id: 'scene-2-voice-1', src: NEW }]);
    expect(result.applied).toBe(1);
  });
});

describe('E02 prepare-audio composition', () => {
  it('returns the coherent publication pair for the same revision with the target read-set', () => {
    const prepared = prepareComposition('audio', {
      source_html: HTML, revision: 4, replacements: [{ target_id: 'scene-2-voice-1', src: NEW }],
    });
    expect(prepared.prepared).toBe(true);
    expect(prepared.applied).toBe(1);
    expect(prepared.undoable).toBe(true);
    expect(prepared.before_audio).toEqual([{ target_id: 'scene-2-voice-1', src: OLD }]);
    expect(prepared.content_hash).toBe(compositionHash(prepared.html));
    expect(prepared.html).toContain(NEW);
    expect(prepared.elements.version).toBe(2);
    expect(prepared.elements.revision).toBe(4);
    expect(prepared.elements.elements.every((e: { revision: number }) => e.revision === 4)).toBe(true);
    // O registry derivado da revisão nova descreve a faixa como o HTML publicado.
    const audio = prepared.elements.elements.find((e: { id: string }) => e.id === 'scene-2-voice-1');
    expect(audio).toBeTruthy();
    expect(JSON.stringify(audio)).toContain(NEW);
    expect(HTML).toContain(OLD);
  });

  it('refuses an unknown target without producing a candidate', () => {
    expect(() => prepareComposition('audio', {
      source_html: HTML, revision: 4, replacements: [{ target_id: 'scene-7-voice-1', src: NEW }],
    })).toThrowError(/AUDIO_TARGET_NOT_FOUND/);
  });

  it('C2.3/R04: a precondição expected_src atravessa o prepare e 409 sem mutar nada', () => {
    const postCommit = HTML.replace(`src="${OLD}"`, `src="${CAND_URL}"`);
    // Correlaciona (URL assinada ≡ path cru do journal) → aplica.
    const applied = prepareComposition('audio', {
      source_html: postCommit, revision: 5,
      replacements: [{ target_id: 'scene-2-voice-1', src: NEW }],
      expected_src: [{ target_id: 'scene-2-voice-1', src: CAND_PATH }],
    }, STORAGE_CONTEXT);
    expect(applied.prepared).toBe(true);
    expect(applied.before_audio).toEqual([{ target_id: 'scene-2-voice-1', src: CAND_URL }]);
    // Diverge (o alvo tem CAND, o undo espera OLD) → 409 codificado.
    let thrown = null;
    try {
      prepareComposition('audio', {
        source_html: postCommit, revision: 5,
        replacements: [{ target_id: 'scene-2-voice-1', src: NEW }],
        expected_src: [{ target_id: 'scene-2-voice-1', src: OLD }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('UNDO_PRECONDITION_CONFLICT');
    expect(thrown?.status).toBe(409);
    expect(thrown?.conflicts).toEqual([{
      target_id: 'scene-2-voice-1', observed: CAND_URL, expected: OLD,
    }]);
  });

  it('still requires a valid revision and a canonical composition root', () => {
    expect(() => prepareComposition('audio', {
      source_html: HTML, revision: 0, replacements: [{ target_id: 'scene-2-voice-1', src: NEW }],
    })).toThrowError(/INVALID_COMPOSITION_REVISION/);
    expect(() => prepareComposition('audio', {
      source_html: '<h1>x</h1>', revision: 4, replacements: [{ target_id: 'scene-2-voice-1', src: NEW }],
    })).toThrowError(/INVALID_COMPOSITION_ROOT/);
  });

  it('C2.5/R04: editor supplies server storage context and ignores body attempts to override it', () => {
    const editor = createCompositionEditor(STORAGE_CONTEXT);
    const input = { source_html: HTML.replace(`src="${OLD}"`, `src="${CAND_URL}"`), revision: 5,
      replacements: [{ target_id: 'scene-2-voice-1', src: NEW }],
      expected_src: [{ target_id: 'scene-2-voice-1', src: CAND_PATH }],
      storageUrl: 'https://other.example.test' };
    expect(editor.prepare('audio', input).prepared).toBe(true);
    const foreign = { ...input, source_html: input.source_html.replace('media.example.test/storage/', 'other.example.test/storage/') };
    expect(() => editor.prepare('audio', foreign))
      .toThrowError(expect.objectContaining({ code: 'UNDO_PRECONDITION_CONFLICT', status: 409 }));
  });
});
