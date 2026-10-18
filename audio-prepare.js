/**
 * audio-prepare — E02/I3: substituição ALVO-ÚNICA do `src` de uma faixa de
 * voz na composição publicada.
 *
 * Contrato: docs/video-engine/EVOLUCAO_EDITOR_ASSISTIDO_PRO_2026-10-13/
 *           15_E02_CONTRATOS_AUDIO_TEMPO.md §7.
 *
 * A regeneração de um segmento (E02) produz bytes NOVOS num path imutável; o
 * HTML canónico só passa a referir esses bytes se o `src` da faixa alvo for
 * reescrito E a nova revisão for publicada (CAS/receipt). Este módulo é essa
 * única reescrita: PURA (sem efeitos), determinística e limitada ao alvo.
 *
 * Invariantes:
 *   - Só elementos `<audio data-track="vo">` com o `id` estável pedido são
 *     tocados; todos os outros atributos e elementos ficam byte-a-byte.
 *   - Alvo ausente/não-VO/sem `src` é ERRO codificado (409), nunca skip mudo:
 *     um pedido que não encontra o alvo não pode ser reportado como aplicado.
 *   - O valor anterior (`before`) sai no resultado para o delta do journal
 *     (undo E01 é uma NOVA revisão com o `src` antigo, nunca um blob apagado).
 *   - `expected_src` (read-set do undo/redo E02) é uma PRECONDIÇÃO: o `src`
 *     atual do alvo tem de ser o objeto que o comando a inverter escreveu.
 *     A comparação Storage inclui origin, bucket e object key —
 *     o HTML publicado leva URL assinada cujo token expira/roda, o journal
 *     grava o path cru do namespace imutável. Divergência → 409
 *     UNDO_PRECONDITION_CONFLICT com os conflicts estruturados, SEM mutar
 *     nenhum alvo (o HTML de saída de um 409 nunca é publicado).
 */

import { parseHTML } from 'linkedom';

/** Id estável do alvo (`scene-N-voice-K`, eventualmente `-copy-N`). */
const TARGET_ID = /^[A-Za-z][A-Za-z0-9_-]{0,199}$/;
const MAX_SRC = 2048;
const MAX_REPLACEMENTS = 8;
/** Um `src` de media é um URL http(s) sem espaços nem delimitadores de atributo. */
const SRC_VALUE = /^https?:\/\/[^\s"'<>`\\]+$/;
/**
 * `expected_src` aceita o MESMO formato de `src` do replacement (URL http(s))
 * OU o path cru do namespace imutável gravado no journal
 * (`projects/{uuid}/composition-revisions/{uuid}/audio/...`).
 */
const RAW_PATH = /^projects\/[0-9a-f-]{36}\/composition-revisions\/[0-9a-f-]{36}\/audio\/[^\s"'<>`\\?#]+$/i;

function reject(code, status = 400) {
  throw Object.assign(new Error(code), { code, status });
}

/**
 * Storage identity, never just an object key across origins/buckets. Raw
 * journal paths belong only to the server's configured E01 artifact store.
 * No authority is inferred from input HTML or request body. Invalid encoding
 * cannot establish equivalence; callers receive the usual structured 409.
 */
function storageIdentity(src, storageUrl) {
  try {
    if (RAW_PATH.test(src)) {
      const configured = new URL(storageUrl);
      if (!['https:', 'http:'].includes(configured.protocol) || configured.username || configured.password) return null;
      return JSON.stringify([configured.origin, 'video-artifacts', src]);
    }
    const url = new URL(src);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const match = /^\/storage\/v1\/object(?:\/(?:sign|public|authenticated))?\/([^/]+)\/(.+)$/.exec(url.pathname);
    return match ? JSON.stringify([url.origin, decodeURIComponent(match[1]), decodeURIComponent(match[2])]) : null;
  } catch {
    return null;
  }
}

function srcMatches(expected, observed, storageUrl) {
  if (expected === observed) return true;
  const identity = storageIdentity(expected, storageUrl);
  return identity !== null && identity === storageIdentity(observed, storageUrl);
}

function validateReplacementList(replacements) {
  return Array.isArray(replacements) && replacements.length >= 1 && replacements.length <= MAX_REPLACEMENTS
    && replacements.every(r => r && typeof r.target_id === 'string' && TARGET_ID.test(r.target_id)
      && typeof r.src === 'string' && r.src.length > 0 && r.src.length <= MAX_SRC
      && (SRC_VALUE.test(r.src) || RAW_PATH.test(r.src)));
}

/**
 * Reescreve o `src` das faixas de voz pedidas.
 *
 * @param {string} html composição canónica (bytes publicados)
 * @param {Array<{target_id: string, src: string}>} replacements alvos exatos
 * @param {Array<{target_id: string, src: string}>} [expectedSrc] read-set do
 *        undo/redo: origin/bucket/object key do alvo têm de coincidir antes
 *        de qualquer substituição (409 em divergência).
 * @param {{storageUrl?: string}} [context] trusted server configuration only
 * @returns {{html: string, before: Array<{target_id: string, src: string}>, applied: number, undoable: true}}
 */
export function replaceAudioTargets(html, replacements, expectedSrc, { storageUrl } = {}) {
  if (typeof html !== 'string' || !html.trim()) reject('INVALID_COMPOSITION_HTML');
  if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > MAX_REPLACEMENTS
    || replacements.some(r => !r || typeof r.target_id !== 'string' || !TARGET_ID.test(r.target_id)
      || typeof r.src !== 'string' || r.src.length === 0 || r.src.length > MAX_SRC || !SRC_VALUE.test(r.src))
    || new Set(replacements.map(r => r.target_id)).size !== replacements.length) {
    reject('INVALID_AUDIO_REPLACEMENTS');
  }
  if (expectedSrc !== undefined) {
    if (!validateReplacementList(expectedSrc) || new Set(expectedSrc.map(r => r.target_id)).size !== expectedSrc.length) {
      reject('INVALID_EXPECTED_SRC');
    }
    for (const entry of expectedSrc) {
      if (!replacements.some(r => r.target_id === entry.target_id)) {
        reject('INVALID_EXPECTED_SRC');
      }
    }
  }

  const { document } = parseHTML(html);
  const before = [];
  const conflicts = [];
  const expectedByTarget = new Map((expectedSrc ?? []).map(e => [e.target_id, e]));
  // Primeiro lê e valida TUDO; só depois escreve — um 409 de precondição nunca
  // deixa meio-aplicado (a saída deste módulo é a que o CAS publica).
  for (const replacement of replacements) {
    const el = document.getElementById(replacement.target_id);
    if (!el) reject('AUDIO_TARGET_NOT_FOUND', 409);
    if (String(el.localName ?? '').toLowerCase() !== 'audio' || el.getAttribute('data-track') !== 'vo') {
      reject('AUDIO_TARGET_NOT_VOICE', 409);
    }
    const current = el.getAttribute('src');
    if (current === null) reject('AUDIO_TARGET_WITHOUT_SRC', 409);
    before.push({ target_id: replacement.target_id, src: current });
    const expected = expectedByTarget.get(replacement.target_id);
    if (expected && !srcMatches(expected.src, current, storageUrl)) {
      conflicts.push({
        target_id: replacement.target_id,
        observed: current,
        expected: expected.src,
      });
    }
  }
  if (conflicts.length) {
    throw Object.assign(new Error('UNDO_PRECONDITION_CONFLICT'), {
      code: 'UNDO_PRECONDITION_CONFLICT', status: 409, conflicts,
    });
  }
  for (const replacement of replacements) {
    document.getElementById(replacement.target_id).setAttribute('src', replacement.src);
  }
  // O `src` é o ÚNICO atributo escrito: a janela (data-start/data-duration) e
  // o mix authored (data-volume/data-muted/data-fade-*) do alvo permanecem.
  return { html: document.toString(), before, applied: replacements.length, undoable: true };
}

export default replaceAudioTargets;
