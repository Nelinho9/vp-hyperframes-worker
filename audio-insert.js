/**
 * audio-insert — E07 (§7.7): criação e remoção EXPLÍCITA de uma faixa de voz
 * ausente na composição publicada.
 *
 * Contrato: docs/video-engine/EVOLUCAO_EDITOR_ASSISTIDO_PRO_2026-10-13/
 *           15_E02_CONTRATOS_AUDIO_TEMPO.md §7.7.
 *
 * A regeneração E02 (`audio-prepare.js`) substitui o `src` de um alvo que já
 * existe. Uma voz excluída antes do render por falta de fit
 * (`VO_WINDOW_OVERFLOW`) nunca chega a ter tag no HTML — o prepare devolve
 * `AUDIO_TARGET_NOT_FOUND` e nada a repara. Este módulo é essa operação:
 *
 *   - INSERT: cria a tag canónica `<audio data-track="vo">` com a JANELA DA
 *     CENA (a fonte que o render lê), no bloco de tracks quando existe;
 *   - REMOVE: apaga APENAS o alvo criado, com precondição de identidade de
 *     Storage, para o undo/redo do journal E01 (o redo reutiliza os bytes
 *     aceites — nunca ressintetiza).
 *
 * Invariantes:
 *   - alvo já presente → 409 `AUDIO_TARGET_PRESENT` (nunca duplicar ids);
 *   - cena ausente/não-clip/sem janela numérica → 409 (nunca inventar timing);
 *   - tudo é validado antes de qualquer mutação (sem aplicação parcial);
 *   - a tag criada não leva `class="clip"` nem `crossorigin` (as duas
 *     invariantes do `injectAudioTracks` do build).
 *
 * Os fades por omissão e a escala à janela espelham `buildVoAudioTag`
 * (`supabase/functions/video-v4-steps/audioInjection.ts`); a tag tem de ser
 * indistinguível da que o build injeta.
 */

import { parseHTML } from 'linkedom';
import { srcMatches } from './audio-prepare.js';

/** Id estável do alvo (`scene-N-voice-K`), com a cena derivada do próprio id. */
const VOICE_TARGET = /^scene-(\d+)-voice-([1-9]\d*)$/;
/** Mesmo formato dos restantes alvos (`audio-prepare.js`). */
const TARGET_ID = /^[A-Za-z][A-Za-z0-9_-]{0,199}$/;
const MAX_SRC = 2048;
const MAX_INSERTIONS = 8;
const MAX_REMOVALS = 8;
/** Um `src` de media é um URL http(s) sem espaços nem delimitadores de atributo. */
const SRC_VALUE = /^https?:\/\/[^\s"'<>`\\]+$/;
const VO_TRACK_INDEX = '8';
const DEFAULT_VO_FADE_IN_MS = 200;
const DEFAULT_VO_FADE_OUT_MS = 300;

function reject(code, status = 400) {
  throw Object.assign(new Error(code), { code, status });
}

/** Fades declarativos escalados à janela — mesma regra de `buildVoAudioTag`. */
function fadeMs(durationSec) {
  const maxFadeMs = Number.isFinite(durationSec) ? Math.max(0, durationSec * 1000 - 500) : 0;
  let fadeIn = Math.round(DEFAULT_VO_FADE_IN_MS);
  let fadeOut = Math.round(DEFAULT_VO_FADE_OUT_MS);
  if (fadeIn + fadeOut > maxFadeMs && fadeIn + fadeOut > 0) {
    const k = maxFadeMs / (fadeIn + fadeOut);
    fadeIn = Math.floor(fadeIn * k);
    fadeOut = Math.floor(fadeOut * k);
  }
  if (!Number.isFinite(fadeIn) || fadeIn < 0) fadeIn = 0;
  if (!Number.isFinite(fadeOut) || fadeOut < 0) fadeOut = 0;
  return { fadeIn, fadeOut };
}

function isCommentNode(node) {
  return node && node.nodeType === 8;
}

function commentText(node) {
  return String(node.textContent ?? node.data ?? '');
}

/** Marcador final do bloco de tracks (`injectAudioTracks` do build). */
function findTracksEndMarker(root) {
  const stack = [...root.childNodes];
  while (stack.length) {
    const node = stack.shift();
    if (isCommentNode(node) && commentText(node).includes('/__vp-audio-tracks')) return node;
    if (node?.childNodes?.length) stack.push(...node.childNodes);
  }
  return null;
}

function sceneWindow(document, sceneId) {
  const scene = document.getElementById(sceneId);
  if (!scene) reject('AUDIO_SCENE_NOT_FOUND', 409);
  if (String(scene.localName ?? '').toLowerCase() !== 'div') reject('AUDIO_SCENE_NOT_FOUND', 409);
  const classes = (scene.getAttribute('class') ?? '').split(/\s+/);
  if (!classes.includes('clip')) reject('AUDIO_SCENE_NOT_FOUND', 409);
  const startAttr = scene.getAttribute('data-start');
  const durationAttr = scene.getAttribute('data-duration');
  if (startAttr === null || durationAttr === null) reject('AUDIO_SCENE_WINDOW_INVALID', 409);
  const start = Number.parseFloat(startAttr);
  const duration = Number.parseFloat(durationAttr);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
    reject('AUDIO_SCENE_WINDOW_INVALID', 409);
  }
  return { start, duration, startAttr, durationAttr };
}

function validateInsertions(insertions) {
  if (!Array.isArray(insertions) || insertions.length < 1 || insertions.length > MAX_INSERTIONS) {
    reject('INVALID_AUDIO_INSERTIONS');
  }
  const ids = new Set();
  for (const insertion of insertions) {
    if (!insertion || typeof insertion.target_id !== 'string' || !VOICE_TARGET.test(insertion.target_id)
      || typeof insertion.src !== 'string' || insertion.src.length === 0 || insertion.src.length > MAX_SRC
      || !SRC_VALUE.test(insertion.src) || ids.has(insertion.target_id)) {
      reject('INVALID_AUDIO_INSERTIONS');
    }
    ids.add(insertion.target_id);
  }
}

/**
 * Cria a tag de voz canónica de um alvo AUSENTE.
 *
 * @param {string} html composição canónica (bytes publicados)
 * @param {Array<{target_id: string, src: string}>} insertions alvos a criar
 * @returns {{html: string, before: [], inserted: Array<{target_id: string, scene_id: string, start: number, duration: number}>, applied: number, undoable: true}}
 */
export function insertAudioTargets(html, insertions) {
  if (typeof html !== 'string' || !html.trim()) reject('INVALID_COMPOSITION_HTML');
  validateInsertions(insertions);

  const { document } = parseHTML(html);
  const root = document.querySelector('[data-composition-id]');
  if (!root) reject('INVALID_COMPOSITION_ROOT');

  // Lê e valida TUDO antes de qualquer escrita: um 409 nunca deixa meio-aplicado.
  const planned = insertions.map((insertion) => {
    const sceneMatch = VOICE_TARGET.exec(insertion.target_id);
    const sceneId = `scene-${sceneMatch[1]}`;
    if (document.getElementById(insertion.target_id)) reject('AUDIO_TARGET_PRESENT', 409);
    const window = sceneWindow(document, sceneId);
    return { ...insertion, sceneId, window };
  });

  const marker = findTracksEndMarker(root);
  const inserted = [];
  for (const plan of planned) {
    const { fadeIn, fadeOut } = fadeMs(plan.window.duration);
    const element = document.createElement('audio');
    element.setAttribute('id', plan.target_id);
    element.setAttribute('src', plan.src);
    element.setAttribute('data-track', 'vo');
    element.setAttribute('data-track-index', VO_TRACK_INDEX);
    element.setAttribute('data-start', plan.window.startAttr);
    element.setAttribute('data-duration', plan.window.durationAttr);
    element.setAttribute('data-fade-in', String(fadeIn));
    element.setAttribute('data-fade-out', String(fadeOut));
    element.setAttribute('preload', 'auto');
    if (marker?.parentNode) marker.parentNode.insertBefore(element, marker);
    else root.appendChild(element);
    inserted.push({
      target_id: plan.target_id, scene_id: plan.sceneId,
      start: plan.window.start, duration: plan.window.duration,
    });
  }

  return { html: document.toString(), before: [], inserted, applied: inserted.length, undoable: true };
}

function validateRemovals(removals) {
  if (!Array.isArray(removals) || removals.length < 1 || removals.length > MAX_REMOVALS) {
    reject('INVALID_AUDIO_REMOVALS');
  }
  const ids = new Set();
  for (const removal of removals) {
    if (!removal || typeof removal.target_id !== 'string' || !TARGET_ID.test(removal.target_id)
      || ids.has(removal.target_id)) {
      reject('INVALID_AUDIO_REMOVALS');
    }
    ids.add(removal.target_id);
  }
}

/**
 * Remove APENAS os alvos de voz pedidos (inverso exato de um insert).
 *
 * @param {string} html composição canónica
 * @param {Array<{target_id: string}>} removals alvos a remover
 * @param {Array<{target_id: string, src: string}>} [expectedSrc] precondição
 *        do journal: o `src` atual do alvo tem de ser o objeto que o comando
 *        a inverter escreveu (identidade de Storage, origin/bucket/key).
 * @param {{storageUrl?: string}} [context] configuração de servidor (nunca body)
 * @returns {{html: string, before: Array<{target_id: string, src: string}>, removed: number, applied: number, undoable: true}}
 */
export function removeAudioTargets(html, removals, expectedSrc, { storageUrl } = {}) {
  if (typeof html !== 'string' || !html.trim()) reject('INVALID_COMPOSITION_HTML');
  validateRemovals(removals);
  if (expectedSrc !== undefined) {
    if (!Array.isArray(expectedSrc) || expectedSrc.length < 1 || expectedSrc.length > MAX_REMOVALS) {
      reject('INVALID_EXPECTED_SRC');
    }
    const expectedIds = new Set();
    for (const entry of expectedSrc) {
      if (!entry || typeof entry.target_id !== 'string' || !TARGET_ID.test(entry.target_id)
        || typeof entry.src !== 'string' || entry.src.length === 0 || entry.src.length > MAX_SRC
        || !(SRC_VALUE.test(entry.src) || entry.src.startsWith('projects/')) || expectedIds.has(entry.target_id)
        || !removals.some((removal) => removal.target_id === entry.target_id)) {
        reject('INVALID_EXPECTED_SRC');
      }
      expectedIds.add(entry.target_id);
    }
  }

  const { document } = parseHTML(html);
  const expectedByTarget = new Map((expectedSrc ?? []).map((entry) => [entry.target_id, entry]));
  const elements = [];
  const before = [];
  const conflicts = [];
  for (const removal of removals) {
    const element = document.getElementById(removal.target_id);
    if (!element) reject('AUDIO_TARGET_NOT_FOUND', 409);
    if (String(element.localName ?? '').toLowerCase() !== 'audio' || element.getAttribute('data-track') !== 'vo') {
      reject('AUDIO_TARGET_NOT_VOICE', 409);
    }
    const current = element.getAttribute('src');
    if (current === null) reject('AUDIO_TARGET_WITHOUT_SRC', 409);
    before.push({ target_id: removal.target_id, src: current });
    elements.push(element);
    const expected = expectedByTarget.get(removal.target_id);
    if (expected && !srcMatches(expected.src, current, storageUrl)) {
      conflicts.push({ target_id: removal.target_id, observed: current, expected: expected.src });
    }
  }
  if (conflicts.length) {
    throw Object.assign(new Error('UNDO_PRECONDITION_CONFLICT'), {
      code: 'UNDO_PRECONDITION_CONFLICT', status: 409, conflicts,
    });
  }
  for (const element of elements) element.parentNode?.removeChild(element);
  return { html: document.toString(), before, removed: elements.length, applied: elements.length, undoable: true };
}

export default { insertAudioTargets, removeAudioTargets };
