/**
 * deterministic.ts — F10.07 (V5.34): QC técnico determinístico, SEPARADO do VLM.
 *
 * Módulo PURO dual-runtime (Deno + Node/vitest): sem Deno.*, sem Node-only
 * APIs, imports relativos com extensão `.ts`, sem dependências externas.
 *
 * Regras de honestidade (contrato C9 + proibições F10):
 * - Medição ausente ⇒ `unknown` declarado (nunca `pass` por defeito, nunca
 *   `fail` por ausência de instrumento — exceto asset requerido ausente, que
 *   é facto do manifesto, não do instrumento).
 * - 5 imagens NÃO validam narração, música ou movimento contínuo: canais
 *   áudio/motion ficam `unchecked` salvo medição real publicada no evidence.
 * - Erro do provider VLM NUNCA fabrica score; estes checks correm
 *   independentemente e sobrevivem à falha do VLM (o caller anexa o resumo).
 * - Limiares exportados como consts para fixtures/testes; sem números mágicos
 *   escondidos.
 *
 * Fonte das medições: `outputs[0]` do evidence-manifest (worker publica dims/
 * fps/duração; áudio/container/codec ainda NÃO publicados — ver riscos para
 * o worker). Sem worker com essas stats, os checks de áudio ficam `unknown`
 * com `audio_checked:false` explícito.
 */

export const DETERMINISTIC_VERSION = 1 as const;

/** Dims permitidas nesta fase (mapa do ratio F04 — sem esticar/cortar). */
export const DETERMINISTIC_ALLOWED_DIMS = ['1920x1080', '1080x1920', '1080x1080'] as const;

/** FPS provados nesta fase: só 30 (contrato F04). */
export const DETERMINISTIC_SUPPORTED_FPS = [30] as const;

/** Tolerância de duração quando o fps é desconhecido (modo narrado). */
export const DETERMINISTIC_DURATION_TOL_SEC = 0.25 as const;

/** Pico acima disto (dBFS) é clipping digital. */
export const DETERMINISTIC_CLIP_PEAK_DBFS = -1.0 as const;

/** Proporção de silêncio acima disto é faixa muda/silenciosa. */
export const DETERMINISTIC_SILENCE_RATIO = 0.9 as const;

/** Deriva A/V acima disto é dessincronização. */
export const DETERMINISTIC_AV_SYNC_TOL_SEC = 0.5 as const;

/** Altura mínima de texto legível a 1080p (escala linear com a altura). */
export const DETERMINISTIC_TEXT_MIN_HEIGHT_PX = 24 as const;

/** Margem de segurança das readability bounds (px a 1080p, escala linear). */
export const DETERMINISTIC_TEXT_SAFE_MARGIN_PX = 8 as const;

export type DeterministicChannel = 'dimensions' | 'duration' | 'assets' | 'readability' | 'audio' | 'sync' | 'motion';

export type DeterministicStatus = 'pass' | 'fail' | 'unknown';

export interface DeterministicCheck {
  id: string;
  channel: DeterministicChannel;
  status: DeterministicStatus;
  detail: string;
}

export interface DeterministicObserved {
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  duration_sec?: number | null;
  container?: string | null;
  codec?: string | null;
  size_bytes?: number | null;
  audio?: {
    present?: boolean | null;
    peak_dbfs?: number | null;
    silence_ratio?: number | null;
    duration_sec?: number | null;
  } | null;
}

export interface DeterministicAsset {
  id: string;
  required: boolean;
  present: boolean;
}

export interface DeterministicTextElement {
  id: string;
  x?: number | null;
  y?: number | null;
  w?: number | null;
  h?: number | null;
  font_px?: number | null;
}

export interface DeterministicInput {
  observed: DeterministicObserved | null;
  /** Duração alvo aprovada (effective config); null = só sanidade absoluta. */
  targetDurationSec?: number | null;
  assets?: DeterministicAsset[] | null;
  textElements?: DeterministicTextElement[] | null;
  /** Digests dos snapshots do set (motion estático determinístico). */
  snapshotDigests?: string[] | null;
}

export interface DeterministicReport {
  deterministic_version: typeof DETERMINISTIC_VERSION;
  checks: DeterministicCheck[];
  passed: number;
  failed: number;
  unknown: number;
  /** true sse stats de áudio reais foram fornecidas (medido, nunca estimado). */
  audio_checked: boolean;
  /** Escopo explícito por canal: o que foi medido vs assumido. */
  channels: {
    visual: 'vlm+deterministic-bounds' | 'deterministic-bounds-only' | 'unchecked';
    audio: 'measured' | 'unchecked';
    motion: 'static-detected' | 'unchecked';
    deterministic: 'executed' | 'no-observed-output';
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function check(id: string, channel: DeterministicChannel, status: DeterministicStatus, detail: string): DeterministicCheck {
  return { id, channel, status, detail };
}

function checkDimensions(observed: DeterministicObserved): DeterministicCheck {
  const w = numOrNull(observed.width);
  const h = numOrNull(observed.height);
  if (w === null || h === null) {
    return check('DET_DIMS', 'dimensions', 'unknown', 'dims do output não publicadas no evidence (unknown, não presumir 1080p)');
  }
  const key = `${Math.round(w)}x${Math.round(h)}`;
  if (!(DETERMINISTIC_ALLOWED_DIMS as readonly string[]).includes(key)) {
    return check('DET_DIMS', 'dimensions', 'fail', `dims ${key} fora do mapa F04 [${DETERMINISTIC_ALLOWED_DIMS.join(',')}]`);
  }
  const fps = numOrNull(observed.fps);
  if (fps !== null && !(DETERMINISTIC_SUPPORTED_FPS as readonly number[]).includes(Math.round(fps))) {
    return check('DET_DIMS', 'dimensions', 'fail', `fps ${fps} fora das capacidades aprovadas [${DETERMINISTIC_SUPPORTED_FPS.join(',')}]`);
  }
  return check('DET_DIMS', 'dimensions', 'pass', `dims ${key}${fps !== null ? ` @${fps}fps` : ''} dentro do contrato F04`);
}

function checkDuration(observed: DeterministicObserved, target: number | null): DeterministicCheck {
  const dur = numOrNull(observed.duration_sec);
  if (dur === null) {
    return check('DET_DURATION', 'duration', 'unknown', 'duração do output não medida (ffprobe/worker); sem duração não há DONE disfarçado de pass');
  }
  if (!(dur > 0) || !(dur <= 600)) {
    return check('DET_DURATION', 'duration', 'fail', `duração ${dur}s fora de (0,600]`);
  }
  if (target === null) {
    return check('DET_DURATION', 'duration', 'pass', `duração ${dur}s sã; alvo aprovado ausente (sanidade absoluta apenas)`);
  }
  const fps = numOrNull(observed.fps);
  const tol = fps !== null && fps > 0 ? 1 / fps + 0.02 : DETERMINISTIC_DURATION_TOL_SEC;
  if (Math.abs(dur - target) > tol) {
    return check('DET_DURATION', 'duration', 'fail', `duração ${dur}s vs alvo ${target}s (±${Math.round(tol * 1000) / 1000}s)`);
  }
  return check('DET_DURATION', 'duration', 'pass', `duração ${dur}s dentro de ±${Math.round(tol * 1000) / 1000}s do alvo ${target}s`);
}

function checkAssets(assets: DeterministicAsset[] | null | undefined): DeterministicCheck {
  if (!Array.isArray(assets) || assets.length === 0) {
    return check('DET_ASSETS', 'assets', 'unknown', 'manifesto de assets ausente: missing media não verificável (unknown, não pass)');
  }
  const missing = assets.filter((a) => a && a.required === true && a.present !== true).map((a) => a.id);
  if (missing.length > 0) {
    return check('DET_ASSETS', 'assets', 'fail', `missing media requerida: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` (+${missing.length - 8})` : ''}`);
  }
  return check('DET_ASSETS', 'assets', 'pass', `${assets.length} asset(s) requerido(s) presentes`);
}

function checkReadability(observed: DeterministicObserved, texts: DeterministicTextElement[] | null | undefined): DeterministicCheck {
  if (!Array.isArray(texts) || texts.length === 0) {
    return check('DET_TEXT_BOUNDS', 'readability', 'unknown', 'elementos de texto com bbox ausentes: readability bounds não verificáveis (contraste/tamanho real exigem leitura; 5 imagens não provam)');
  }
  const w = numOrNull(observed.width);
  const h = numOrNull(observed.height);
  if (w === null || h === null) {
    return check('DET_TEXT_BOUNDS', 'readability', 'unknown', 'dims do output ausentes: bounds sem referencial (unknown)');
  }
  const scale = h / 1080;
  const minH = DETERMINISTIC_TEXT_MIN_HEIGHT_PX * scale;
  const margin = DETERMINISTIC_TEXT_SAFE_MARGIN_PX * scale;
  const violations: string[] = [];
  for (const t of texts) {
    const x = numOrNull(t.x);
    const y = numOrNull(t.y);
    const tw = numOrNull(t.w);
    const th = numOrNull(t.h);
    if (x === null || y === null || tw === null || th === null) continue; // sem bbox: ignorar, não falhar
    if (x < -margin || y < -margin || x + tw > w + margin || y + th > h + margin) {
      violations.push(`${t.id}: fora do frame`);
      continue;
    }
    const fontPx = numOrNull(t.font_px);
    const effH = fontPx !== null ? fontPx : th;
    if (effH < minH) violations.push(`${t.id}: altura ${Math.round(effH)}px < mín ${Math.round(minH)}px`);
  }
  if (violations.length > 0) {
    return check('DET_TEXT_BOUNDS', 'readability', 'fail', `readability bounds: ${violations.slice(0, 6).join('; ')}${violations.length > 6 ? ` (+${violations.length - 6})` : ''}`);
  }
  return check('DET_TEXT_BOUNDS', 'readability', 'pass', `${texts.length} texto(s) dentro das bounds e acima do mínimo legível`);
}

function checkAudioPresence(audio: DeterministicObserved['audio']): DeterministicCheck {
  if (!audio || typeof audio !== 'object' || audio.present === null || audio.present === undefined) {
    return check('DET_AUDIO_PRESENCE', 'audio', 'unknown', 'stats de áudio não publicadas: narração/música NÃO validadas por 5 imagens (audio_checked=false)');
  }
  if (audio.present !== true) {
    return check('DET_AUDIO_PRESENCE', 'audio', 'fail', 'output sem stream áudio (presence=false medido)');
  }
  return check('DET_AUDIO_PRESENCE', 'audio', 'pass', 'stream áudio presente (medido)');
}

function checkAudioClip(audio: DeterministicObserved['audio']): DeterministicCheck {
  const peak = audio && typeof audio === 'object' ? numOrNull(audio.peak_dbfs) : null;
  if (peak === null) {
    return check('DET_AUDIO_CLIP', 'audio', 'unknown', 'pico dBFS não medido: clipping não avaliável (unknown)');
  }
  if (peak > DETERMINISTIC_CLIP_PEAK_DBFS) {
    return check('DET_AUDIO_CLIP', 'audio', 'fail', `pico ${peak}dBFS acima de ${DETERMINISTIC_CLIP_PEAK_DBFS}dBFS (clipping)`);
  }
  return check('DET_AUDIO_CLIP', 'audio', 'pass', `pico ${peak}dBFS sem clipping`);
}

function checkAudioSilence(audio: DeterministicObserved['audio']): DeterministicCheck {
  const ratio = audio && typeof audio === 'object' ? numOrNull(audio.silence_ratio) : null;
  if (ratio === null) {
    return check('DET_AUDIO_SILENCE', 'audio', 'unknown', 'proporção de silêncio não medida (unknown)');
  }
  if (ratio > DETERMINISTIC_SILENCE_RATIO) {
    return check('DET_AUDIO_SILENCE', 'audio', 'fail', `silêncio ${Math.round(ratio * 100)}% acima de ${Math.round(DETERMINISTIC_SILENCE_RATIO * 100)}% (faixa muda/silenciosa)`);
  }
  return check('DET_AUDIO_SILENCE', 'audio', 'pass', `silêncio ${Math.round(ratio * 100)}% dentro do limite`);
}

function checkAvSync(observed: DeterministicObserved): DeterministicCheck {
  const audio = observed.audio;
  const audioDur = audio && typeof audio === 'object' ? numOrNull(audio.duration_sec) : null;
  const videoDur = numOrNull(observed.duration_sec);
  if (audioDur === null || videoDur === null) {
    return check('DET_AV_SYNC', 'sync', 'unknown', 'durações A/V não medidas em conjunto: sincronização não avaliável (5 imagens não provam sync)');
  }
  if (Math.abs(audioDur - videoDur) > DETERMINISTIC_AV_SYNC_TOL_SEC) {
    return check('DET_AV_SYNC', 'sync', 'fail', `áudio ${audioDur}s vs vídeo ${videoDur}s (deriva > ${DETERMINISTIC_AV_SYNC_TOL_SEC}s)`);
  }
  return check('DET_AV_SYNC', 'sync', 'pass', `áudio ${audioDur}s alinhado ao vídeo ${videoDur}s (±${DETERMINISTIC_AV_SYNC_TOL_SEC}s)`);
}

/**
 * Gate anti-estático determinístico (espelha o ANTI-STATIC GATE do prompt em
 * código): set com 1 só digest distinto é uma imagem estática, não um vídeo
 * com motion. Com >1 digest distinto o veredicto é `unknown` com limitação —
 * N imagens não provam movimento contínuo.
 */
export function checkMotionStatic(digests: string[] | null | undefined): DeterministicCheck {
  if (!Array.isArray(digests) || digests.length < 2) {
    return check('DET_MOTION', 'motion', 'unknown', 'amostras insuficientes para avaliar motion (5 imagens não validam movimento contínuo)');
  }
  const unique = new Set(digests.filter((d) => typeof d === 'string' && d !== ''));
  if (unique.size <= 1) {
    return check('DET_MOTION', 'motion', 'fail', `set estático: ${digests.length} snapshot(s) com bytes idênticos (sem progressão de cena/motion)`);
  }
  return check('DET_MOTION', 'motion', 'unknown', `${unique.size}/${digests.length} digests distintos: frames diferem mas N imagens não provam narração/música/movimento contínuo`);
}

/**
 * Corre a bateria determinística. `observed` null (sem outputs no evidence)
 * ⇒ bateria `no-observed-output`: checks estruturais ficam unknown, assets/
 * readability avaliados pelo que houver. Nunca lança.
 */
export function runDeterministicChecks(input: DeterministicInput): DeterministicReport {
  const observed: DeterministicObserved = input && input.observed && typeof input.observed === 'object' ? input.observed : {};
  const hasObserved = input && input.observed !== null && input.observed !== undefined
    && (numOrNull(observed.width) !== null || numOrNull(observed.duration_sec) !== null || numOrNull(observed.size_bytes) !== null);
  const target = input && typeof input.targetDurationSec === 'number' && Number.isFinite(input.targetDurationSec)
    ? input.targetDurationSec
    : null;
  const audio = observed.audio ?? null;
  const audioMeasured = audio !== null && typeof audio === 'object';
  const audio_checked = audioMeasured && (audio.present === true || audio.present === false);

  const checks: DeterministicCheck[] = [
    checkDimensions(observed),
    checkDuration(observed, target),
    checkAssets(input ? input.assets : null),
    checkReadability(observed, input ? input.textElements : null),
    checkAudioPresence(audio),
    checkAudioClip(audio),
    checkAudioSilence(audio),
    checkAvSync(observed),
    checkMotionStatic(input ? input.snapshotDigests : null),
  ];

  let passed = 0;
  let failed = 0;
  let unknown = 0;
  for (const c of checks) {
    if (c.status === 'pass') passed++;
    else if (c.status === 'fail') failed++;
    else unknown++;
  }

  const motionCheck = checks.find((c) => c.id === 'DET_MOTION');
  return {
    deterministic_version: DETERMINISTIC_VERSION,
    checks,
    passed,
    failed,
    unknown,
    audio_checked,
    channels: {
      visual: 'vlm+deterministic-bounds',
      audio: audio_checked ? 'measured' : 'unchecked',
      motion: motionCheck && motionCheck.status === 'fail' ? 'static-detected' : 'unchecked',
      deterministic: hasObserved ? 'executed' : 'no-observed-output',
    },
  };
}
