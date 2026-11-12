/**
 * sampler.ts — F10.06 (V5.34): coverage do sampler + diagnóstico de snapshots.
 *
 * Módulo PURO dual-runtime (Deno + Node/vitest): sem Deno.*, sem Node-only
 * APIs, imports relativos com extensão `.ts`, sem dependências externas.
 *
 * Duas responsabilidades distintas (nunca confundir):
 *
 * 1. COVERAGE: os snapshots do evidence cobrem as cenas/cuts/transições e
 *    tempos válidos do output? Lacunas aqui são factos do evidence/sampler,
 *    registados no relatório — nunca pretexto para rewrite editorial.
 * 2. DEFEITO: o snapshot está defeituoso (bytes ausentes, PNG inválido,
 *    truncado, duplicado)? Diagnosticar ANTES de qualquer chamada paga (VLM)
 *    ou proposta paga (rewrite): black frame / selector warning / runtime
 *    gate são erros do sampler/runtime com códigos próprios, distintos de
 *    findings editoriais.
 *
 * Limite honesto: sem descodificar píxeis (sem libs de imagem no edge), um
 * PNG válido mas todo-preto NÃO é distinguível de um frame escuro legítimo
 * por bytes. `assessFrameLuminance` consome a luminância média quando o
 * produtor (worker) a publica; ausente ⇒ `unknown` declarado, nunca
 * presunção editorial. Espelho worker (amostragem/pixel) é NOTA documentada,
 * não implementada cross-repo nesta tarefa (ver F10.06 riscos).
 */

export const SAMPLER_VERSION = 1 as const;

/** Teto de snapshots avaliados por execução (espelha MAX_SNAPSHOTS). */
export const SAMPLER_MAX_SNAPSHOTS = 5 as const;

/** Bytes abaixo disto raramente são um frame real (PNG 1080p válido é maior). */
export const SAMPLER_TINY_BYTES = 2048 as const;

/** Assinatura PNG: 89 50 4E 47 0D 0A 1A 0A. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

// ─── Coverage ────────────────────────────────────────────────────────────────

export interface SamplerSnapshotRef {
  path: string;
  scene_id?: string | null;
  time_s?: number | null;
}

export interface SamplerTransitionRef {
  /** Instante da transição/cut em segundos (centro do overlap aprovado). */
  at: number;
  id?: string;
}

export interface SamplerCoverageInput {
  snapshots: SamplerSnapshotRef[];
  /** Cenas root que o output contém (do evidence scene_ids). */
  sceneIds: string[];
  /** Duração medida do output em segundos; null = tempos não verificáveis. */
  outputDurationSec: number | null;
  /** Transições/cuts aprovados; ausente = cobertura de fronteiras `unknown`. */
  transitions?: SamplerTransitionRef[] | null;
}

export interface SamplerCoverageReport {
  sampler_version: typeof SAMPLER_VERSION;
  /** true quando todas as verificações APLICÁVEIS passam. */
  complete: boolean;
  sampled: number;
  total_scenes: number;
  covered_scenes: string[];
  uncovered_scenes: string[];
  /** Fração de cenas cobertas (0–1); null quando não há cenas declaradas. */
  scene_coverage_ratio: number | null;
  /** Tempos fora de [0, duração]; vazio quando duração é unknown. */
  invalid_times: Array<{ path: string; time_s: number; reason: string }>;
  /** Transições sem snapshot próximo (±0.75s); null quando não avaliado. */
  uncovered_transitions: string[] | null;
  boundary_coverage: 'full' | 'partial' | 'unknown';
  limitations: string[];
}

const TRANSITION_NEIGHBORHOOD_SEC = 0.75 as const;

export function validateSamplerCoverage(input: SamplerCoverageInput): SamplerCoverageReport {
  const snapshots = Array.isArray(input.snapshots) ? input.snapshots : [];
  const sceneIds = Array.isArray(input.sceneIds) ? input.sceneIds.filter((s) => typeof s === 'string' && s !== '') : [];
  const limitations: string[] = [];
  const covered = new Set<string>();
  for (const s of snapshots) {
    if (typeof s.scene_id === 'string' && s.scene_id !== '') covered.add(s.scene_id);
  }
  const covered_scenes = sceneIds.filter((s) => covered.has(s));
  const uncovered_scenes = sceneIds.filter((s) => !covered.has(s));
  const scene_coverage_ratio = sceneIds.length > 0
    ? Math.round((covered_scenes.length / sceneIds.length) * 100) / 100
    : null;
  if (sceneIds.length === 0) limitations.push('scene_ids ausentes no evidence: cobertura de cenas não verificável (unknown, não pass)');

  const invalid_times: SamplerCoverageReport['invalid_times'] = [];
  const dur = typeof input.outputDurationSec === 'number' && Number.isFinite(input.outputDurationSec) ? input.outputDurationSec : null;
  if (dur === null) {
    limitations.push('duração do output não medida: tempos dos snapshots não verificáveis (unknown, não válidos por defeito)');
  } else {
    for (const s of snapshots) {
      if (typeof s.time_s !== 'number' || !Number.isFinite(s.time_s)) continue;
      if (s.time_s < 0 || s.time_s > dur + 0.05) {
        invalid_times.push({ path: s.path, time_s: s.time_s, reason: `time_s=${s.time_s}s fora de [0,${dur}s] do output` });
      }
    }
  }

  let uncovered_transitions: string[] | null = null;
  let boundary_coverage: SamplerCoverageReport['boundary_coverage'] = 'unknown';
  const transitions = input.transitions ?? null;
  if (Array.isArray(transitions) && transitions.length > 0 && dur !== null) {
    const uncovered: string[] = [];
    transitions.forEach((t, i) => {
      const id = typeof t.id === 'string' && t.id !== '' ? t.id : `transition-${i + 1}`;
      const near = snapshots.some((s) =>
        typeof s.time_s === 'number' && Number.isFinite(s.time_s) && Math.abs(s.time_s - t.at) <= TRANSITION_NEIGHBORHOOD_SEC);
      if (!near) uncovered.push(id);
    });
    uncovered_transitions = uncovered;
    boundary_coverage = uncovered.length === 0 ? 'full' : 'partial';
  } else {
    limitations.push('transições/cuts sem tempos aprovados: cobertura de fronteiras unknown (5 imagens não provam cuts)');
  }

  const complete = uncovered_scenes.length === 0
    && invalid_times.length === 0
    && (uncovered_transitions === null || uncovered_transitions.length === 0)
    && snapshots.length > 0
    && sceneIds.length > 0;
  return {
    sampler_version: SAMPLER_VERSION,
    complete,
    sampled: snapshots.length,
    total_scenes: sceneIds.length,
    covered_scenes,
    uncovered_scenes,
    scene_coverage_ratio,
    invalid_times,
    uncovered_transitions,
    boundary_coverage,
    limitations,
  };
}

// ─── Diagnóstico de bytes (antes de qualquer chamada paga) ───────────────────

export type SnapshotDefectCode =
  | 'SAMPLER_SNAPSHOT_MISSING'
  | 'SAMPLER_SNAPSHOT_EMPTY'
  | 'SAMPLER_NOT_PNG'
  | 'SAMPLER_TRUNCATED'
  | 'SAMPLER_DUPLICATE_BYTES'
  | 'SAMPLER_TINY_SUSPECT';

export type SnapshotDiagnosis =
  | { path: string; ok: true; size_bytes: number; digest: string }
  | { path: string; ok: false; code: SnapshotDefectCode; grade: 'error' | 'warning'; detail: string; size_bytes: number };

/** FNV-1a hex local (não importar provenance para manter o módulo sem deps). */
function bytesDigestHex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function hasIend(bytes: Uint8Array): boolean {
  // Chunk IEND: 00 00 00 00 49 45 4E 44 AE 42 60 82 — procurar a assinatura
  // em qualquer posição (tolerante a chunks ancilares após IDAT).
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 73 && bytes[i + 1] === 69 && bytes[i + 2] === 78 && bytes[i + 3] === 68) {
      return true;
    }
  }
  return false;
}

/**
 * Classifica os bytes de UM snapshot. `knownDigests` acumula digests dos
 * snapshots já vistos da mesma execução (deteção de set estático/duplicado).
 * Nunca lança.
 */
export function diagnoseSnapshotBytes(
  path: string,
  bytes: Uint8Array | null | undefined,
  knownDigests?: Set<string>,
): SnapshotDiagnosis {
  if (bytes === null || bytes === undefined) {
    return { path, ok: false, code: 'SAMPLER_SNAPSHOT_MISSING', grade: 'error', detail: 'download vazio/ausente (storage devolveu null)', size_bytes: 0 };
  }
  if (bytes.byteLength === 0) {
    return { path, ok: false, code: 'SAMPLER_SNAPSHOT_EMPTY', grade: 'error', detail: 'ficheiro com 0 bytes', size_bytes: 0 };
  }
  let isPng = bytes.byteLength >= 8;
  if (isPng) {
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
      if (bytes[i] !== PNG_SIGNATURE[i]) { isPng = false; break; }
    }
  }
  if (!isPng) {
    return { path, ok: false, code: 'SAMPLER_NOT_PNG', grade: 'error', detail: 'assinatura PNG ausente (bytes não são PNG)', size_bytes: bytes.byteLength };
  }
  if (!hasIend(bytes)) {
    return { path, ok: false, code: 'SAMPLER_TRUNCATED', grade: 'error', detail: 'chunk IEND ausente (PNG truncado/corrompido)', size_bytes: bytes.byteLength };
  }
  const digest = bytesDigestHex(bytes);
  if (knownDigests && knownDigests.has(digest)) {
    return { path, ok: false, code: 'SAMPLER_DUPLICATE_BYTES', grade: 'error', detail: 'bytes idênticos a outro snapshot do set (set estático — motion não avaliável)', size_bytes: bytes.byteLength };
  }
  if (knownDigests) knownDigests.add(digest);
  if (bytes.byteLength < SAMPLER_TINY_BYTES) {
    return { path, ok: false, code: 'SAMPLER_TINY_SUSPECT', grade: 'warning', detail: `apenas ${bytes.byteLength} bytes (<${SAMPLER_TINY_BYTES}): suspeito de frame degenerado, não bloqueante isolado`, size_bytes: bytes.byteLength };
  }
  return { path, ok: true, size_bytes: bytes.byteLength, digest };
}

// ─── Luminância (black-frame honesto) ────────────────────────────────────────

export type LuminanceAssessment =
  | { verdict: 'ok'; mean: number }
  | { verdict: 'black-frame'; mean: number }
  | { verdict: 'unknown'; reason: string };

/**
 * Black frame vs frame escuro legítimo só se distingue com píxeis. O edge
 * não descodifica PNG; quando o produtor publica `mean_luminance` (0–255),
 * aplica-se o limiar; sem medição, `unknown` declarado. Limiar conservador:
 * média < 6/255 em TODA a imagem é instrumentalmente preto.
 */
export function assessFrameLuminance(meanLuminance: number | null | undefined): LuminanceAssessment {
  if (typeof meanLuminance !== 'number' || !Number.isFinite(meanLuminance)) {
    return { verdict: 'unknown', reason: 'mean_luminance não publicada pelo produtor (píxeis não descodificados no edge)' };
  }
  if (meanLuminance < 6) return { verdict: 'black-frame', mean: meanLuminance };
  return { verdict: 'ok', mean: meanLuminance };
}

// ─── Classificação de sinal (sampler/runtime vs editorial) ───────────────────

export type SamplerSignalKind = 'sampler-error' | 'selector-warning' | 'runtime-gate' | 'editorial';

/**
 * Sinais multi-padrão (listas, não um regex frágil monolítico). Ordem de
 * precedência: sampler-error > runtime-gate > selector-warning > editorial.
 * O H4 frontend (`qualityAutoFix.ts`) mantém o seu regex narrow — ver riscos
 * F10.09; o backend usa esta classificação para `origin`/`rewriteEligible`.
 */
const SAMPLER_ERROR_SIGNALS = [
  /snapshot/i, /black frame/i, /blank/i, /duplicat/i,
  /truncat/i, /corrupt/i, /0 bytes/i, /missing-content/i, /sampler/i,
] as const;

const RUNTIME_GATE_SIGNALS = [
  /runtime/i, /\bgate\b/i, /ffmpeg/i, /ffprobe/i, /worker/i, /timeout/i,
  /\b50[0-4]\b/, /\boom\b/i, /out of memory/i, /selector/i, /no frames/i,
] as const;

const SELECTOR_WARNING_SIGNALS = [
  /waiting for/i, /empty hook/i, /hook vazio/i, /t≈0/i, /\bt=0\b/i,
  /1\.5s/i, /spring-pop/i, /1080p.*9:16/i, /9:16.*1080p/i, /first frame/i,
] as const;

export function classifySamplerSignal(text: string | null | undefined): SamplerSignalKind {
  const t = typeof text === 'string' ? text : '';
  if (t === '') return 'editorial';
  if (SAMPLER_ERROR_SIGNALS.some((re) => re.test(t))) return 'sampler-error';
  if (RUNTIME_GATE_SIGNALS.some((re) => re.test(t))) return 'runtime-gate';
  if (SELECTOR_WARNING_SIGNALS.some((re) => re.test(t))) return 'selector-warning';
  return 'editorial';
}

export interface FindingLike {
  scene?: unknown;
  severity?: unknown;
  category?: unknown;
  message?: unknown;
  suggestion?: unknown;
}

/**
 * Um finding é suspeito de mismatch sampler-vs-entrada (NÃO editorial) sse o
 * sinal combinado message+suggestion+categoria classifica como não-editorial.
 * Estes findings nunca devem, sozinhos, motivar rewrite pago: o H3 resolve-os
 * no sampler (prova: re-run do gate sem rewrite).
 */
export function isSamplerMismatchFinding(finding: FindingLike | null | undefined): boolean {
  if (!finding || typeof finding !== 'object') return false;
  const text = `${typeof finding.category === 'string' ? finding.category : ''} ${typeof finding.message === 'string' ? finding.message : ''} ${typeof finding.suggestion === 'string' ? finding.suggestion : ''}`;
  return classifySamplerSignal(text) !== 'editorial';
}

export type FindingOrigin = 'editorial' | 'sampler' | 'deterministic';

/**
 * Etiqueta de origem + elegibilidade de rewrite para UM finding:
 * - sampler (mismatch) ⇒ rewriteEligible=false SEMPRE;
 * - severity info ou scene nula ⇒ rewriteEligible=false (ruído/global);
 * - restante editorial warning|error com cena ⇒ elegível (F10.09 decide).
 */
export function tagFindingOrigin(finding: FindingLike): { origin: FindingOrigin; rewriteEligible: boolean } {
  if (isSamplerMismatchFinding(finding)) return { origin: 'sampler', rewriteEligible: false };
  const severity = typeof finding.severity === 'string' ? finding.severity : 'info';
  const scene = typeof finding.scene === 'string' ? finding.scene : null;
  if ((severity !== 'warning' && severity !== 'error') || scene === null) {
    return { origin: 'editorial', rewriteEligible: false };
  }
  return { origin: 'editorial', rewriteEligible: true };
}
